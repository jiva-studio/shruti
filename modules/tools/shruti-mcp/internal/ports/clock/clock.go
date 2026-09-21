// Package clock defines the port through which a use case reads the wall clock.
package clock

import "time"

// Clock reports the current time. The application and domain layers take one
// instead of calling time.Now, so a test can pin the moment.
type Clock interface {
	Now() time.Time
}
