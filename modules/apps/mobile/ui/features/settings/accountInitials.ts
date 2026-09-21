/** Avatar fallback: first letter of the first and last word of the display name. */
export function accountInitials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || ""
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ""
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase()
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase()
}
