-- Host claim, and an invite the host screen can re-show.
--
-- A room minted from the shell has no browser behind it, so the invite phrase
-- the CLI printed lives nowhere the host screen can reach: the invite was
-- stored hashed, and only the creating browser kept the plaintext. Keeping the
-- phrase beside its hash lets any device holding the host capability re-share
-- the invite. The phrase is worth one room for at most 24 hours in the lobby
-- and confers no host authority; the host capability itself stays hash-only.
ALTER TABLE rooms ADD COLUMN invite_token TEXT;

-- The first device to open the host screen claims the room: it is issued a
-- room-scoped host session, and the hash of that session is recorded here.
-- A later device presenting the host capability may claim it in turn, which is
-- a takeover rather than a rejection — the capability is still the authority,
-- and an operator who reopens the link on a new phone must not be locked out.
ALTER TABLE rooms ADD COLUMN host_claim_hash TEXT;
ALTER TABLE rooms ADD COLUMN host_claimed_at TEXT;

CREATE UNIQUE INDEX rooms_host_claim_hash ON rooms (host_claim_hash)
  WHERE host_claim_hash IS NOT NULL;
