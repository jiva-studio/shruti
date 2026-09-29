// Module github.com/jiva-studio/shruti/logging sets up slog the way every Go
// service logs: JSON on stdout with the field names the log pipeline and its
// dashboards parse. Services import it through a `replace` directive.
module github.com/jiva-studio/shruti/logging

go 1.24
