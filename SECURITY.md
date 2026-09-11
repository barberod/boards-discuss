# Security policy

## Supported versions

Security updates are applied to the latest published version of Boards Discuss.

## Reporting a vulnerability

Please report security issues privately to the repository owner rather than opening a public issue. Include the affected version, reproduction steps, impact, and any suggested mitigation. Do not include a live Azure DevOps PAT or private work-item content.

You should receive an acknowledgment within five business days. A fix and coordinated disclosure timeline will be provided after validation.

## Data handling

- Personal access tokens are stored only through VS Code SecretStorage.
- Work-item data is requested directly from the configured Azure DevOps organization.
- The extension does not include analytics, telemetry, or an intermediary service.
- Azure DevOps HTML is sanitized before display, and external navigation is limited to HTTP, HTTPS, and mail links.
