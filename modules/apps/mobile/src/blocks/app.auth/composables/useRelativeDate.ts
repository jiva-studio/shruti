
export function useRelativeDate() {
  function parse(timestamp: number) {
    const date = new Date(timestamp)
    const now = new Date()
    
    // Check if the date is today
    const isToday = date.getDate() === now.getDate() &&
                    date.getMonth() === now.getMonth() &&
                    date.getFullYear() === now.getFullYear()
    
    // Format hours and minutes with leading zeros
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    
    // Calculate days ago
    const diffTime = Math.abs(now.getTime() - date.getTime())
    const daysAgo = Math.floor(diffTime / (1000 * 60 * 60 * 24))
    
    return {
      daysAgo: isToday ? 0 : daysAgo,
      time: {
        hour: hours,
        min: minutes
      }
    }
  }

  return { parse }
}