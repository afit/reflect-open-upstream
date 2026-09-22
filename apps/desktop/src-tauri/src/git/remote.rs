//! Network operations: fetch and push over HTTPS or SSH.
//!
//! Credentials are supplied through libgit2's credential callback — they are
//! **never** embedded in the remote URL, so they never touch `.git/config` or
//! disk. A per-call token (the managed GitHub sign-in) authenticates over
//! HTTPS; without one, credentials resolve locally — the SSH agent for ssh
//! remotes (Plan 16 V1; generic HTTPS waits for V2's credential helpers).

use std::cell::RefCell;
use std::path::Path;

use git2::{Cred, CredentialType, FetchOptions, PushOptions, RemoteCallbacks, Repository};
use serde::Serialize;

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

/// Pick a credential for one callback invocation.
///
/// With a token (the managed GitHub path) it is HTTPS basic auth as
/// `x-access-token` — never offered for any other credential type, so a
/// token can never leak to a transport we didn't intend, and offered only
/// **once**: libgit2 invokes this callback a single time for a credential
/// the host accepts (including across a push's two requests, which reuse
/// the connection's credential) but re-invokes it without bound for one the
/// host rejects. A second ask is therefore always a rejection, and
/// re-answering it would loop forever. Without a token (generic remotes,
/// Plan 16 V1) the chain is: answer a bare username probe, then offer the
/// SSH agent exactly once, for the same reason; generic HTTPS fails fast
/// until V2 adds credential-helper resolution. Errors carry
/// `ErrorCode::Auth` so they classify as `AppError::Auth` (surfaced as
/// needs-attention, not retried blindly).
fn resolve_credential(
    token: Option<&str>,
    username_from_url: Option<&str>,
    allowed: CredentialType,
    ssh_agent_tried: &mut bool,
    userpass_tried: &mut bool,
) -> Result<Cred, git2::Error> {
    use git2::{ErrorClass, ErrorCode};
    if let Some(token) = token {
        if !allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Callback,
                "the remote requires an unsupported credential type (token sign-in is HTTPS-only)",
            ));
        }
        if *userpass_tried {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Http,
                "github.com rejected the sign-in token — check Reflect still has access to this repository, or sign out and back in",
            ));
        }
        *userpass_tried = true;
        return Cred::userpass_plaintext("x-access-token", token);
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
            "HTTPS sign-in is only supported for github.com — use an SSH remote URL (git@host:owner/repo.git) for other hosts",
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
fn callbacks_with_credentials<'cb>(token: Option<String>) -> RemoteCallbacks<'cb> {
    let mut callbacks = RemoteCallbacks::new();
    let mut ssh_agent_tried = false;
    let mut userpass_tried = false;
    callbacks.credentials(move |_url, username_from_url, allowed| {
        resolve_credential(
            token.as_deref(),
            username_from_url,
            allowed,
            &mut ssh_agent_tried,
            &mut userpass_tried,
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
pub(super) fn fetch(root: &Path, token: Option<String>) -> AppResult<RemoteDelta> {
    let repo = open_existing(root)?;
    {
        let mut remote = origin(&repo)?;
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(callbacks_with_credentials(token));
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
pub(super) fn clone(url: &str, target: &Path, token: Option<String>) -> AppResult<()> {
    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks_with_credentials(token));
    git2::build::RepoBuilder::new()
        .fetch_options(fetch_options)
        .clone(url, target)?;
    Ok(())
}

/// Push the current branch to `origin`. Rejections come back as data, not
/// errors — the sync engine branches on them (non-fast-forward → pull/merge/
/// retry; anything else → surface the remote's message).
pub(super) fn push(root: &Path, token: Option<String>) -> AppResult<PushOutcome> {
    let repo = open_existing(root)?;
    let branch = current_branch(&repo)?;
    let mut remote = origin(&repo)?;

    let rejection: RefCell<Option<String>> = RefCell::new(None);
    let sideband: RefCell<String> = RefCell::new(String::new());
    let result = {
        let mut callbacks = callbacks_with_credentials(token);
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

    use super::resolve_credential;

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
        let mut userpass = false;
        expect_ok(resolve_credential(
            Some("ghs_token"),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
            &mut userpass,
        ));
    }

    #[test]
    fn token_is_never_offered_to_non_https_transports() {
        // A github.com remote rewired to ssh, or any future transport, must
        // not receive the managed token as some other credential shape.
        let mut tried = false;
        let mut userpass = false;
        let err = expect_err(resolve_credential(
            Some("ghs_token"),
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
            &mut userpass,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("HTTPS-only"), "{err}");
        assert!(!tried, "the agent must not be consulted on the token path");
    }

    #[test]
    fn ssh_username_probe_is_answered() {
        let mut tried = false;
        let mut userpass = false;
        expect_ok(resolve_credential(
            None,
            None,
            CredentialType::USERNAME,
            &mut tried,
            &mut userpass,
        ));
        assert!(!tried);
    }

    #[test]
    fn ssh_agent_is_offered_once_then_errors_actionably() {
        // libgit2 re-invokes the callback after a rejected credential; the
        // second ask must become the actionable error, not an infinite loop.
        let mut tried = false;
        let mut userpass = false;
        expect_ok(resolve_credential(
            None,
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
            &mut userpass,
        ));
        assert!(tried);

        let err = expect_err(resolve_credential(
            None,
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
            &mut userpass,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("ssh-add"), "{err}");
    }

    #[test]
    fn generic_https_fails_fast_with_the_ssh_suggestion() {
        // Plan 16 V1: no credential-helper resolution yet — an honest error
        // beats a half-try that dies somewhere less explicable.
        let mut tried = false;
        let mut userpass = false;
        let err = expect_err(resolve_credential(
            None,
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
            &mut userpass,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("SSH remote URL"), "{err}");
    }

    #[test]
    fn unsupported_credential_types_error_with_auth() {
        let mut tried = false;
        let mut userpass = false;
        let err = expect_err(resolve_credential(
            None,
            None,
            CredentialType::SSH_INTERACTIVE,
            &mut tried,
            &mut userpass,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
    }
}

#[cfg(test)]
mod credential_loop_tests {
    //! The guard exists because of how libgit2 behaves, not how we do, so
    //! testing it needs a real HTTP exchange. The other git tests use path
    //! remotes, which never invoke the credential callback at all.
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::fetch;

    /// pkt-line framing: four hex digits of total length, then the payload.
    fn pkt(payload: &str) -> String {
        format!("{:04x}{payload}", payload.len() + 4)
    }

    /// The smart-HTTP ref advertisement for an empty repository — enough for
    /// libgit2 to consider a fetch complete.
    fn empty_advertisement() -> String {
        format!(
            "{}0000{}0000",
            pkt("# service=git-upload-pack\n"),
            pkt("0000000000000000000000000000000000000000 capabilities^{}\0side-band-64k\n"),
        )
    }

    /// Serve one connection: challenge every unauthenticated request, then
    /// accept or reject the authenticated retry per `accepts`. Keep-alive
    /// matters: libgit2 retries a rejected credential on the same connection,
    /// so a server that hung up after one response would look like a network
    /// fault rather than a rejection.
    fn serve(stream: &mut TcpStream, accepts: bool, challenges: &AtomicUsize) {
        let mut buffer = [0_u8; 4096];
        loop {
            let read = match stream.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            let authenticated =
                String::from_utf8_lossy(&buffer[..read]).contains("Authorization: Basic ");
            let response = if authenticated && accepts {
                let body = empty_advertisement();
                format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: application/x-git-upload-pack-advertisement\r\n\
                     Content-Length: {}\r\n\r\n{body}",
                    body.len()
                )
            } else {
                challenges.fetch_add(1, Ordering::SeqCst);
                "HTTP/1.1 401 Unauthorized\r\n\
                 WWW-Authenticate: Basic realm=\"test\"\r\n\
                 Content-Length: 0\r\n\r\n"
                    .to_string()
            };
            if stream.write_all(response.as_bytes()).is_err() || stream.flush().is_err() {
                return;
            }
        }
    }

    /// A loopback git host that accepts or rejects every credential, and the
    /// count of challenges it issued.
    fn spawn_server(accepts: bool) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let challenges = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&challenges);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                serve(&mut stream, accepts, &counter);
            }
        });
        (format!("http://127.0.0.1:{port}/probe.git"), challenges)
    }

    fn repo_with_origin(url: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", url).unwrap();
        dir
    }

    #[test]
    fn a_rejected_token_is_offered_once_then_fails_actionably() {
        let (url, challenges) = spawn_server(false);
        let dir = repo_with_origin(&url);

        let error = fetch(dir.path(), Some("rejected-token".to_string()))
            .expect_err("a rejected token must not succeed");

        // Without the guard this never returns. Two challenges = answered
        // once, rejected, then refused to answer again.
        assert_eq!(challenges.load(Ordering::SeqCst), 2);
        assert!(
            format!("{error:?}").contains("rejected the sign-in token"),
            "{error:?}"
        );
    }

    #[test]
    fn an_accepted_token_is_asked_for_once() {
        let (url, challenges) = spawn_server(true);
        let dir = repo_with_origin(&url);

        // Self-proving: had libgit2 asked a second time on the success path,
        // the guard would have fired and this would be Err.
        fetch(dir.path(), Some("accepted-token".to_string()))
            .expect("an accepted token must get through the guard");
        assert_eq!(challenges.load(Ordering::SeqCst), 1);
    }
}
