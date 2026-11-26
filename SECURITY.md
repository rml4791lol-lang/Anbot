# Security Policy

## Before you use it

Anbot is an agent that acts on your behalf: it reads and writes files, runs commands and opens web pages when you ask it to. It runs on your own computer and does not upload your data; model requests go to the model provider you configure.

- **Bots read web pages, files and messages.** That content can contain instructions that try to push a Bot past its rights. Anbot uses permission presets, secret redaction and approval for high-risk commands, but none of that is a guarantee.
- **Grant only what a Bot needs.** By default a Bot changes files only inside its working folder. `Full access` means tools run without asking; keep it for Bots you trust.
- **Check actions that leave the machine.** Deletes, pushes, sends and payments are worth a look before you approve them.
- **Do not paste secrets into chats or instructions.** When a Bot needs a key it shows a card in the conversation; you can also add keys ahead of time under **Settings → Tools → Secrets**. Either way the Bot uses the key without seeing its value.
- **A private Bot is isolated from the other Bots in your team, not from the OS.** With shell or network access it can still read system files and reach the network.

The full threat model is in [SECURITY_MODEL.md](SECURITY_MODEL.md).

## Supported versions

Anbot is in preview. Security fixes go into the latest version only; older versions do not receive separate patches.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private reporting:

**Repository page → Security → Report a vulnerability**

Please include:

- what the problem is, and which part it affects (plugin, desktop app, Docker);
- steps to reproduce, or a proof of concept;
- relevant logs or screenshots, and the Anbot and DSH versions.

Remove keys, tokens, your home directory and chat content before you send it.

Keep the details private until a fix ships, and do not test against an Anbot instance that someone else is using.

## What is not a vulnerability

These are known design decisions; a report about them will not produce a fix, though an issue arguing they should change is welcome:

- **Bots have full access inside the Docker container.** The container is the isolation boundary. Escaping the container, or taking secrets out of it, is a finding.
- **The consequences of an action you approved.** For example, giving a Bot full access and having it change files within the scope you granted.
- **Problems in DSH itself.** DSH is upstream; fixes belong in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Ordinary bugs

For anything that is not a security problem, open an [issue](https://github.com/rml4791lol-lang/Anbot/issues). In Anbot, **Settings → Feedback → Report a problem** fills in the version and recent errors for you.
