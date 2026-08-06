package fetch

// ExpireRobots ages every cached robots.txt out, so a test can watch a host
// come back without waiting robotsRetryTTL for it.
func ExpireRobots(c *Client) {
	c.robots.mu.Lock()
	defer c.robots.mu.Unlock()
	for _, h := range c.robots.hosts {
		h.mu.Lock()
		h.entry = nil
		h.mu.Unlock()
	}
}
