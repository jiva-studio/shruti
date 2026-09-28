// Known violation: the domain loads a module whose name is computed, which no
// dependency rule can read.
export async function loadFixture(name: string): Promise<unknown> {
  return import(`../../apps/mobile/infra/${name}/index`)
}
