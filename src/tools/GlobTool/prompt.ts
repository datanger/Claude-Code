export const TOOL_NAME_FOR_PROMPT = 'GlobTool'

export const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
- **You must always provide the 'pattern' parameter as a non-empty string. Example: {"pattern": "src/**/*.ts"}**
- If you do not know the pattern, ask the user for clarification before calling this tool.
`
