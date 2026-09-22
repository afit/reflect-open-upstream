//! Network operations: fetch and push over HTTPS or SSH.
//!
//! Credentials are supplied through libgit2's credential callback — they are
//! **never** embedded in the remote URL, so they never touch `.git/config` or
//! disk. A per-call [`BasicCredential`] authenticates over HTTPS — the
//! managed GitHub sign-in or a per-host entry from the user's keychain,
//! whichever core picked; without one, credentials resolve locally through
//! the SSH agent (Plan 16 V1).

use std::cell::RefCell;
use std::path::Path;

use git2::{Cred, CredentialType, FetchOptions, PushOptions, RemoteCallbacks, Repository};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::repo::{current_branch, open_existing};

/// Where the local branch stands relative to its last-fetched remote
/// counterpart (no network — call after `fetch`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDelta {
    pub ahead: usize,
    pub behind: usize,
}

/// Result of a push attempt. `pushed: false` with `non_fast_forward: true` is
/// the normal two-device case (pull, merge, retry); a `rejection_message`
/// carries anything else the remote said (e.g. GitHub push protection).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub pushed: bool,
    /// The remote moved past us (another device pushed first): the caller
    /// pulls, merges, and retries. Auth/network failures are `AppError`s,
    /// never this.
    pub non_fast_forward: bool,
    pub rejection_message: Option<String>,
}

/// An HTTPS basic-auth credential for one fetch/push/clone.
///
/// Which credential belongs to which remote is `@reflect/core`'s decision —
/// this module only knows how to present one, and deliberately knows nothing
/// about GitHub. The managed GitHub sign-in arrives as username
/// `x-access-token`; a generic remote as the user's own username.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BasicCredential {
    pub username: String,
    pub secret: String,
}

/// Pick a credential for one callback invocation.
///
/// A supplied credential is HTTPS basic auth, and is **never** offered for
/// any other credential type — so it can never leak to a transport we didn't
/// intend. With no credential the chain is: answer a bare username probe,
/// then offer the SSH agent exactly once — libgit2 re-invokes the callback
/// after a rejection, and re-offering the same agent would loop forever, so
/// the second ask becomes the actionable error. Errors carry
/// `ErrorCode::Auth` so they classify as `AppError::Auth` (surfaced as
/// needs-attention, not retried blindly).
fn resolve_credential(
    credential: Option<&BasicCredential>,
    username_from_url: Option<&str>,
    allowed: CredentialType,
    ssh_agent_tried: &mut bool,
) -> Result<Cred, git2::Error> {
    use git2::{ErrorClass, ErrorCode};
    if let Some(credential) = credential {
        if !allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Callback,
                "the remote requires an unsupported credential type (token sign-in is HTTPS-only)",
            ));
        }
        return Cred::userpass_plaintext(&credential.username, &credential.secret);
    }
    // SSH asks in two rounds: first the username alone (`ssh://host/…` URLs
    // that don't carry one), then a key for it.
    if allowed.contains(CredentialType::USERNAME) {
        return Cred::username(username_from_url.unwrap_or("git"));
    }
    if allowed.contains(CredentialType::SSH_KEY) {
        if *ssh_agent_tried {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Ssh,
                "the SSH agent offered no key this host accepts — `ssh-add` the right key, then check `ssh -T git@<host>` works",
            ));
        }
        *ssh_agent_tried = true;
        return Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
    }
    if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
        return Err(git2::Error::new(
            ErrorCode::Auth,
            ErrorClass::Http,
            "no username and access token are stored for this host — add them, or use an SSH remote URL (git@host:owner/repo.git)",
        ));
    }
    Err(git2::Error::new(
        ErrorCode::Auth,
        ErrorClass::Callback,
        "the remote requires an unsupported credential type",
    ))
}

/// `RemoteCallbacks` pre-wired with the credential chain — the one
/// configuration fetch, clone, and push all share. Callers layer their own
/// callbacks (push status, sideband) on top.
fn callbacks_with_credentials<'cb>(credential: Option<BasicCredential>) -> RemoteCallbacks<'cb> {
    let mut callbacks = RemoteCallbacks::new();
    let mut ssh_agent_tried = false;
    callbacks.credentials(move |_url, username_from_url, allowed| {
        resolve_credential(
            credential.as_ref(),
            username_from_url,
            allowed,
            &mut ssh_agent_tried,
        )
    });
    callbacks
}

fn origin(repo: &Repository) -> AppResult<git2::Remote<'_>> {
    repo.find_remote("origin")
        .map_err(|_| AppError::not_found("no backup remote is configured for this graph"))
}

/// Fetch `origin` (configured refspecs) and report ahead/behind for the
/// current branch.
pub(super) fn fetch(root: &Path, credential: Option<BasicCredential>) -> AppResult<RemoteDelta> {
    let repo = open_existing(root)?;
    {
        let mut remote = origin(&repo)?;
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(callbacks_with_credentials(credential));
        remote.fetch(&[] as &[&str], Some(&mut opts), None)?;
    }
    local_delta(&repo)
}

/// Ahead/behind vs the already-fetched `origin/<branch>`; tolerates the unborn
/// and never-pushed cases (a fresh backup repo has no remote branch yet).
pub(super) fn local_delta(repo: &Repository) -> AppResult<RemoteDelta> {
    let branch = current_branch(repo)?;
    let local = repo.refname_to_id(&format!("refs/heads/{branch}")).ok();
    let remote = repo
        .refname_to_id(&format!("refs/remotes/origin/{branch}"))
        .ok();
    match (local, remote) {
        (Some(local), Some(remote)) => {
            let (ahead, behind) = repo.graph_ahead_behind(local, remote)?;
            Ok(RemoteDelta { ahead, behind })
        }
        (Some(local), None) => Ok(RemoteDelta {
            ahead: count_commits(repo, local)?,
            behind: 0,
        }),
        (None, Some(remote)) => Ok(RemoteDelta {
            ahead: 0,
            behind: count_commits(repo, remote)?,
        }),
        (None, None) => Ok(RemoteDelta {
            ahead: 0,
            behind: 0,
        }),
    }
}

fn count_commits(repo: &Repository, from: git2::Oid) -> AppResult<usize> {
    let mut walk = repo.revwalk()?;
    walk.push(from)?;
    Ok(walk.filter_map(Result::ok).count())
}

/// Clone `url` into `target` (restore on a fresh machine). git2 refuses a
/// non-empty existing directory, which is exactly the safety we want — a
/// restore must never write into a folder that already has content.
pub(super) fn clone(
    url: &str,
    target: &Path,
    credential: Option<BasicCredential>,
) -> AppResult<()> {
    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks_with_credentials(credential));
    git2::build::RepoBuilder::new()
        .fetch_options(fetch_options)
        .clone(url, target)?;
    Ok(())
}

/// Push the current branch to `origin`. Rejections come back as data, not
/// errors — the sync engine branches on them (non-fast-forward → pull/merge/
/// retry; anything else → surface the remote's message).
pub(super) fn push(root: &Path, credential: Option<BasicCredential>) -> AppResult<PushOutcome> {
    let repo = open_existing(root)?;
    let branch = current_branch(&repo)?;
    let mut remote = origin(&repo)?;

    let rejection: RefCell<Option<String>> = RefCell::new(None);
    let sideband: RefCell<String> = RefCell::new(String::new());
    let result = {
        let mut callbacks = callbacks_with_credentials(credential);
        callbacks.push_update_reference(|_refname, status| {
            if let Some(message) = status {
                *rejection.borrow_mut() = Some(message.to_string());
            }
            Ok(())
        });
        // GitHub explains pre-receive declines (push protection, size limits)
        // on the sideband channel; capture it so rejections are actionable.
        callbacks.sideband_progress(|data| {
            sideband
                .borrow_mut()
                .push_str(&String::from_utf8_lossy(data));
            true
        });
        let mut opts = PushOptions::new();
        opts.remote_callbacks(callbacks);
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        remote.push(&[refspec.as_str()], Some(&mut opts))
    };

    let rejection = rejection.into_inner();
    let sideband = sideband.into_inner();
    match result {
        Ok(()) => match rejection {
            None => Ok(PushOutcome {
                pushed: true,
                non_fast_forward: false,
                rejection_message: None,
            }),
            Some(message) => Ok(classify_rejection(message, &sideband)),
        },
        Err(err) if err.code() == git2::ErrorCode::NotFastForward => Ok(PushOutcome {
            pushed: false,
            non_fast_forward: true,
            rejection_message: Some(err.message().to_string()),
        }),
        Err(err) => {
            if let Some(message) = rejection {
                return Ok(classify_rejection(message, &sideband));
            }
            Err(AppError::from(err))
        }
    }
}

fn classify_rejection(message: String, sideband: &str) -> PushOutcome {
    let lowered = message.to_lowercase();
    let non_fast_forward = lowered.contains("non-fast-forward")
        || lowered.contains("fetch first")
        || lowered.contains("cannot lock ref");
    let detail = sideband.trim();
    let full = if detail.is_empty() {
        message
    } else {
        format!("{message}\n{detail}")
    };
    PushOutcome {
        pushed: false,
        non_fast_forward,
        rejection_message: Some(full),
    }
}

#[cfg(test)]
mod credential_tests {
    use git2::{Cred, CredentialType, ErrorCode};

    use super::{resolve_credential, BasicCredential};

    /// The managed GitHub sign-in, as core presents it.
    fn github() -> BasicCredential {
        BasicCredential {
            username: "x-access-token".into(),
            secret: "ghs_token".into(),
        }
    }

    /// A generic remote's keychain entry.
    fn host() -> BasicCredential {
        BasicCredential {
            username: "alex".into(),
            secret: "pat".into(),
        }
    }

    // `Cred` implements no `Debug`, so unwrap/expect can't print it.
    fn expect_ok(result: Result<Cred, git2::Error>) {
        if let Err(err) = result {
            panic!("expected a credential: {err}");
        }
    }

    fn expect_err(result: Result<Cred, git2::Error>) -> git2::Error {
        match result {
            Ok(_) => panic!("expected an error, got a credential"),
            Err(err) => err,
        }
    }

    #[test]
    fn token_authenticates_https() {
        let mut tried = false;
        expect_ok(resolve_credential(
            Some(&github()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
        ));
    }

    #[test]
    fn token_is_never_offered_to_non_https_transports() {
        // A github.com remote rewired to ssh, or any future transport, must
        // not receive the managed token as some other credential shape.
        let mut tried = false;
        let err = expect_err(resolve_credential(
            Some(&github()),
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("HTTPS-only"), "{err}");
        assert!(!tried, "the agent must not be consulted on the token path");
    }

    #[test]
    fn ssh_username_probe_is_answered() {
        let mut tried = false;
        expect_ok(resolve_credential(
            None,
            None,
            CredentialType::USERNAME,
            &mut tried,
        ));
        assert!(!tried);
    }

    #[test]
    fn ssh_agent_is_offered_once_then_errors_actionably() {
        // libgit2 re-invokes the callback after a rejected credential; the
        // second ask must become the actionable error, not an infinite loop.
        let mut tried = false;
        expect_ok(resolve_credential(
            None,
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
        ));
        assert!(tried);

        let err = expect_err(resolve_credential(
            None,
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("ssh-add"), "{err}");
    }

    #[test]
    fn generic_https_fails_fast_with_the_ssh_suggestion() {
        // Plan 16 V1: no credential-helper resolution yet — an honest error
        // beats a half-try that dies somewhere less explicable.
        let mut tried = false;
        let err = expect_err(resolve_credential(
            None,
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(
            err.message().contains("no username and access token"),
            "{err}"
        );
    }

    #[test]
    fn host_credential_authenticates_https() {
        let mut tried = false;
        expect_ok(resolve_credential(
            Some(&host()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
        ));
        assert!(!tried, "the agent must not be consulted on the HTTPS path");
    }

    #[test]
    fn host_credential_is_never_offered_to_non_https_transports() {
        // A keychain entry for a web host must not be handed to an SSH
        // transport either.
        let mut tried = false;
        let err = expect_err(resolve_credential(
            Some(&host()),
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("HTTPS-only"), "{err}");
        assert!(!tried);
    }

    #[test]
    fn unsupported_credential_types_error_with_auth() {
        let mut tried = false;
        let err = expect_err(resolve_credential(
            None,
            None,
            CredentialType::SSH_INTERACTIVE,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
    }
}
