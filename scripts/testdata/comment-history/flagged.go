package fixture

// Parse used to accept a trailing comma.
func Parse() {}

/*
 * The cache was removed after issue #42.
 */
var cache = 0

func run() {
	cache++ // today this runs once per request
}
