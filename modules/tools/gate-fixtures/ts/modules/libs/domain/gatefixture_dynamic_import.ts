// Known violation: the domain loads an adapter through a dynamic import.
export async function loadFixture(): Promise<unknown> {
  return import("@infra/preferences/index")
}
