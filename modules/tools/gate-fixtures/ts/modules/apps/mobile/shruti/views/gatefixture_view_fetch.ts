// Known violation: a view reaches the network without a port.
export async function fixture(url: string): Promise<boolean> {
  const response = await fetch(url, { method: "HEAD" })
  return response.ok
}
