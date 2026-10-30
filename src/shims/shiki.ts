export type BundledLanguage = string;
export type BundledTheme = string;
export type ThemedToken = {
  content: string;
  color?: string;
  bgColor?: string;
  fontStyle?: number;
  htmlStyle?: Record<string, string>;
};
export type HighlighterGeneric<_L = string, _T = string> = {
  getLoadedLanguages(): string[];
  codeToTokens(
    code: string,
    options?: {
      lang?: string;
      themes?: { dark?: string; light?: string };
    },
  ): { tokens: ThemedToken[][]; fg: string; bg: string; themeName?: string };
};

export async function createHighlighter(
  _options?: unknown,
): Promise<HighlighterGeneric> {
  return {
    getLoadedLanguages() {
      return ["text", "javascript", "typescript", "json", "bash", "python"];
    },
    codeToTokens(code) {
      const tokens = String(code ?? "")
        .split("\n")
        .map((line) => (line === "" ? [] : [{ content: line, color: "inherit" }]));
      return { tokens, fg: "inherit", bg: "transparent", themeName: "github-light" };
    },
  };
}
