import "@paperclipai/plugin-sdk";

declare module "@paperclipai/plugin-sdk" {
  interface PluginConfigClient {
    getWithRevision(companyId?: string): Promise<{
      value: Record<string, unknown>;
      revision: string;
    }>;
  }

  interface PluginSecretsClient {
    resolveWithMetadata(
      secretRef: string | EnvSecretRefBinding,
      options?: { companyId?: string; configPath?: string },
    ): Promise<{
      value: string;
      bindingId: string;
      bindingRevision: string;
      secretVersionId: string;
    }>;
  }
}
