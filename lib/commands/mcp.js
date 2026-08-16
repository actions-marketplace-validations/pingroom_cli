// `mcp` — print the remote MCP endpoint and client setup. Output only: it never
// edits a client's configuration.

import { EXIT, MCP_ENDPOINT } from '../constants.js';
import { fail } from '../util.js';

export function mcp(rest) {
  const claudeCommand = `claude mcp add --transport http pingroom ${MCP_ENDPOINT}`;

  if (rest.length === 0 || (rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help'))) {
    const config = {
      mcpServers: {
        pingroom: { url: MCP_ENDPOINT },
      },
    };
    process.stdout.write(
`PingRoom MCP endpoint:
  ${MCP_ENDPOINT}

Claude Code:
  ${claudeCommand}

Cursor JSON (~/.cursor/mcp.json):
${JSON.stringify(config, null, 2)}

Claude Desktop:
  Customize > Connectors > Add custom connector
  Name: PingRoom
  URL:  ${MCP_ENDPOINT}

After adding the server, use your client's MCP controls to authenticate in the
browser. No API key is needed.
This command only prints setup instructions and does not modify client config.
`);
    return EXIT.OK;
  }

  if (rest.length === 2 && rest[0] === 'add' && rest[1] === 'claude-code') {
    process.stdout.write(
`No client configuration was changed. Copy and run:
  ${claudeCommand}
`);
    return EXIT.OK;
  }

  fail('usage: pingroom mcp [add claude-code]', EXIT.USAGE);
}
