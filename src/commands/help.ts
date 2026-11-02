import { commandName } from '#src/distribution/environment.ts';

export const help = `napplet soyLI

Usage:
  bun run soyli new <folder> [--template boilerplate] [--identity create|connect|later] [--no-install]
  bun run soyli remix <portable-link-or-nostr-id> <folder> [--identity create|connect|later]
  bun run soyli checkpoint "Describe your changes"
  bun run soyli propose "Describe the proposal" [--resume]
  bun run soyli proposals [repository-or-proposal] [--json]
  bun run soyli review [repository-or-proposal] [--no-open] [--rebuild]
  bun run soyli merge <proposal> --revision <event-id> --target <reviewed-local-commit>
  bun run soyli comment <proposal> "Comment" | close|reopen <proposal> ["Reason"]
  bun run soyli push
  bun run soyli setup|build [--project <folder>]
  bun run soyli run <package-script> [arguments...]
  bun run soyli exec <project-tool> [arguments...]
  bun run soyli assets list|sync|remove <id> [--project <folder>]
  bun run soyli assets add <file> <id> [--storage embedded|external] [--license <license>]
  bun run soyli project show|set <json-file> [--project <folder>]
  bun run soyli config [init] [--project <folder>]
  bun run soyli backend init|sync|status [--project <folder>]
  bun run soyli backend init-module|check [manifest.json] [--project <folder>]
  bun run soyli backend deploy <manifest.json> | describe|disable|enable <module-name>
  bun run soyli backend delete-release <module-name> --revision <release-hash>
  bun run soyli multiplayer <scenario.mjs> [--players 2] [--latency 50] [--jitter 15] [--seed 1]
    [--project <folder>] [--timeout 60] [--turn-binary <coturn-executable>]
  bun run soyli record [preview.webm] [--project <folder>]
  bun run soyli screenshot [preview.png] [--project <folder>]
  bun run soyli skills update [--project <folder>]
  bun run soyli account create [--new]
  bun run soyli account show|list|check|backup
  bun run soyli account connect [--stdin] [--session-storage file|keychain]
  bun run soyli account pair [--signer-relay <url>] [--timeout <seconds>] [--open] [--session-storage file|keychain]
  bun run soyli account storage file|keychain
  bun run soyli account import [--stdin]
  bun run soyli account use <npub-or-account-id>
  bun run soyli account export <new-recovery-file> [--passphrase-stdin]
  bun run soyli publish [--project <folder>] [--snapshot] [--dry-run | --resume]
  bun run soyli unpublish|republish|delete [--project <folder>] [--dry-run | --confirm <token> | --resume]
  bun run soyli lifecycle [--project <folder>]
  bun run soyli migrate <napplet-link-or-naddr> [--relay <url>] [--dry-run | --confirm <token> | --resume]
  bun run soyli status [--project <folder>] [--refresh]
  bun run soyli dev [--project <folder>] [--port 4173] [--no-open]
  bun run soyli check [--project <folder>]
  bun run soyli browser install
  bun run soyli browser path [--json]
  bun run soyli doctor [--project <folder>]
  bun run soyli update
  bun run soyli --version

All commands accept --network public|local and --json.
Dev prefers port 4173 and chooses a free port if busy. --port fixes a port; --port 0 chooses any free port.
Development fallback: SOYLI_DANGEROUS_PLAINTEXT_KEYS=1 enables separate, unencrypted
owner-only account files outside Git. Unset it to return to OS-vault accounts.
Create reuses your selected account; account create --new creates and selects another.
Previous identities and backups are kept. Connect accepts a hidden bunker link.
Publish uses the selected account; a running publication keeps its starting account.
Publish updates the stable listing. --snapshot also creates an independent immutable copy.
Each public key keeps separate releases in the same folder. Status/resume use the selected author.
Pair creates a nostrconnect link and QR to approve in your signer (120-second wait).
Remote sessions default to owner-only files outside projects; local private keys use the OS vault.
Use --session-storage keychain with connect/pair to opt in. account storage file migrates
the selected remote session with one OS-vault read, without pairing again.
Signer relays carry encrypted signing requests; they do not change publishing targets.
Create and new save a private nsec backup outside Git projects and report its path.
Account backup saves/reuses that file for an existing local creator. Keep it private.
Import accepts a hidden nsec or encrypted NIP-49 recovery key. With --stdin,
provide the key on line 1 and, for an encrypted key, its passphrase on line 2.
Export writes a passphrase-encrypted NIP-49 file outside Git projects.
Publish targets: --relay <url> --blossom <origin> --grasp <origin> --site <origin>
and optional repeated --mirror <url>. Local mode defaults to the dev services.
Secrets never belong in command arguments. Check/publish download a cached Chromium
browser when needed. Git is required to publish. OS-vault accounts also need an unlocked credential store.`.replaceAll(
  'bun run soyli',
  commandName,
);
