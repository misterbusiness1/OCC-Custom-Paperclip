group "default" {
  targets = ["base", "claude", "codex", "gemini", "opencode", "pi", "hermes"]
}

variable "VERSION" { default = "dev" }
variable "REGISTRY" { default = "ghcr.io/paperclipai" }

# Required public static CLI artifact context and reviewed source/content pins.
variable "ONECLI_CLI_CONTEXT" { default = "./.onecli-cli-artifact-required" }
variable "ONECLI_SOURCE_COMMIT" { default = "" }
variable "ONECLI_SOURCE_TREE" { default = "" }
variable "ONECLI_BINARY_SHA256" { default = "" }

group "identity-workers" {
  targets = ["managed-claude", "managed-codex"]
}

target "base" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.base"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-base:${VERSION}"]
}

target "onecli" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.onecli"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-onecli:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
    ONECLI_SOURCE_COMMIT = ONECLI_SOURCE_COMMIT
    ONECLI_SOURCE_TREE = ONECLI_SOURCE_TREE
    ONECLI_BINARY_SHA256 = ONECLI_BINARY_SHA256
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
    "onecli-cli" = ONECLI_CLI_CONTEXT
  }
}

target "claude" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.claude"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-claude:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
    CLAUDE_VERSION = "2.1.308"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "codex" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.codex"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-codex:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
    CODEX_VERSION = "0.164.0"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "gemini" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.gemini"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-gemini:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "opencode" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.opencode"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-opencode:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "pi" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.pi"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-pi:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "hermes" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.hermes"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-hermes:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "managed-claude" {
  inherits = ["claude"]
  tags = ["${REGISTRY}/agent-runtime-claude-managed:${VERSION}"]
  args = {
    BASE_IMAGE = "paperclipai/agent-runtime-onecli:${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-onecli:${VERSION}" = "target:onecli"
  }
}

target "managed-codex" {
  inherits = ["codex"]
  tags = ["${REGISTRY}/agent-runtime-codex-managed:${VERSION}"]
  args = {
    BASE_IMAGE = "paperclipai/agent-runtime-onecli:${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-onecli:${VERSION}" = "target:onecli"
  }
}
