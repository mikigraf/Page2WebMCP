import React from "react";

/**
 * Publishes the session's request token where a reviewed mutation capability
 * resolves it from: `<meta name="csrf-token" content="...">`.
 */
export function RequestTokenMeta({ token }: { token: string | undefined }) {
  return token ? <meta name="csrf-token" content={token} /> : null;
}
