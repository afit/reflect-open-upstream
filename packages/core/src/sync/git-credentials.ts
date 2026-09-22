import { z } from 'zod'

/**
 * The sync domain's credential shape: what `fetch`/`push`/`clone` present to
 * a remote, and how the managed GitHub sign-in maps onto it.
 */

const gitCredentialSchema = z.object({
  username: z.string().min(1),
  secret: z.string().min(1),
})

/**
 * An HTTPS basic-auth credential for one fetch/push/clone, matching the Rust
 * `BasicCredential`. Rust only knows how to present one; *which* credential
 * belongs to a remote is decided here.
 */
export type GitCredential = z.infer<typeof gitCredentialSchema>

/**
 * The managed GitHub sign-in as a credential. GitHub App tokens authenticate
 * as the fixed username `x-access-token`; the caller has already established
 * that the remote is github.com.
 */
export function githubCredential(token: string): GitCredential {
  return { username: 'x-access-token', secret: token }
}
