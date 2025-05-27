export type Duration = {
  _id: string
  type: "duration"
  version: number
  fullName: Record<string, string>
  minDuration: number
  maxDuration: number
}
