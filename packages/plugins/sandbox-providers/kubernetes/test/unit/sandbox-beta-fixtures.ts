/** Small fixtures from the pinned agent-sandbox v1.0.8 beta schema. */
export function betaSandbox(
  ready = true,
  namespace = "ns",
  name = "pc-abc",
  uid = "uid-1",
) {
  return {
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    metadata: { uid, name, namespace, generation: 1 },
    status: {
      selector: "agents.x-k8s.io/sandbox-name-hash=abc",
      conditions: [
        {
          type: "Ready",
          status: ready ? "True" : "False",
          observedGeneration: 1,
          reason: ready ? "DependenciesReady" : "DependenciesNotReady",
        },
      ],
    },
  };
}
export function betaPod(
  namespace = "ns",
  name = "pc-abc",
  uid = "uid-1",
  podName = name,
) {
  return {
    metadata: {
      uid: `${podName}-uid`,
      name: podName,
      namespace,
      ownerReferences: [
        {
          apiVersion: "agents.x-k8s.io/v1beta1",
          kind: "Sandbox",
          name,
          uid,
          controller: true,
        },
      ],
    },
    status: {
      phase: "Running",
      podIPs: [{ ip: "10.1.2.3" }],
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
}
