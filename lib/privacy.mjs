/** A role's public persona is shared; its user card is private and explicitly owned. */
export function privateUserProfile(character, audience) {
  if (!audience || audience.kind !== "private" || audience.isGroup) return null;
  const { peerId, accountId, scopeKey } = audience;
  const owner = String(character?.userOwnerId ?? "");
  const account = String(character?.userAccountId ?? "");
  if (!/^[1-9][0-9]*$/.test(owner) || !/^[1-9][0-9]*$/.test(account)) return null;
  if (String(peerId) !== owner || String(accountId) !== account || scopeKey !== `private_${owner}`) return null;
  return character.user ?? null;
}

export function audienceFor(event) {
  return { kind: event.kind, peerId: String(event.senderId ?? ""), accountId: String(event.accountId ?? ""), scopeKey: event.scopeKey };
}
