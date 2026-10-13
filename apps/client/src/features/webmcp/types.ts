export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint?: boolean };
  execute(
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<ToolResult>;
}

export type MutationKind = "page" | "pageMove" | "space" | "comment";

export interface ToolDependencies {
  beforeMutation?(
    name: string,
    input: Record<string, unknown>,
  ): void | Promise<void>;
  post(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  signal: AbortSignal;
  isCurrent(): boolean;
  onMutation(
    kind: MutationKind,
    result: Record<string, unknown>,
  ): void | Promise<void>;
}

export interface ModelContextApi {
  registerTool(
    tool: WebMcpTool,
    options?: { signal: AbortSignal },
  ): void | Promise<void>;
  unregisterTool?(name: string): void;
}

export type ModelContextRegistration = {
  api: ModelContextApi;
  mode: "signal" | "named";
};
