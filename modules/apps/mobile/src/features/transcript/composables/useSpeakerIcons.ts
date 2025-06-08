export function useSpeakerIcons(speakers: string[]) {
  const speakerIcons = ['👨‍🦲', '👨🏽‍💼', '👴', '👦', '👨🏽‍🦲', '🙂', '👨🏻‍🦱']

  // Ensure there are enough speakers for languages
  if (speakerIcons.length < speakers.length) {
    throw new Error('Not enough speakers for all languages')
  }

  // Shuffle speakers array to randomize
  const shuffledSpeakers = [...speakerIcons].sort(() => Math.random() - 0.5)

  // Create mapping
  const mapping: Record<string, string> = {}
  speakers.forEach((language: string, index: number) => {
    mapping[language] = shuffledSpeakers[index]
  })

  return mapping
}