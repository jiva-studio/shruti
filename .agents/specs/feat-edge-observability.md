# Task Specification: Edge and mirror probes, alerts and dashboard

**Branch / Worktree**: `feat/edge-observability` (stacked on `feat/edge-role`)
**Status**: `COMPLETED`
**Target Modules**: `infra/observability`, `infra/tests`, `docs/repos/shruti/architecture`

---

## 0. Prior art

- [blackbox_exporter — CONFIGURATION.md, `http_probe`](https://github.com/prometheus/blackbox_exporter/blob/master/CONFIGURATION.md):
  the HTTP prober checks status, headers and body regexps and bounds the body from above (`body_size_limit`); it has no minimum-size option. It exports `probe_http_uncompressed_body_length` and `probe_duration_seconds` per probe.
- [Robust Perception — Configuring Blackbox exporter timeouts](https://www.robustperception.io/configuring-blackbox-exporter-timeouts/):
  a probe's deadline is the scrape timeout (less a small offset), further capped by the module `timeout`; a probe that has not finished by then fails rather than hangs.
- [Amazon Builders' Library — Implementing health checks](https://aws.amazon.com/builders-library/implementing-health-checks/):
  shallow (on-box) and deep (dependency) checks answer different questions; a deep check should cover only hard dependencies, and each should be reported separately so the failing leg is named.
- [Google SRE Workbook — Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/):
  alert on symptoms users see; a `for` duration filters one-probe noise but delays detection, so it stays short on outage-shaped signals and longer on degradation-shaped ones.
- [Prometheus — `file_sd_config`](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#file_sd_config):
  targets and their labels come from a JSON/YAML file that Prometheus re-reads on change; an empty list is a valid job with no targets, and `promtool check config` validates the file.
- [Prometheus — Unit testing for rules](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/):
  `promtool test rules` feeds synthetic series through alerting rules and asserts which alerts fire at which time.

**Adopted**: probe each edge's shallow check (`/healthz`) and both deep checks (`/healthz/api`, `/healthz/cdn`) from a blackbox exporter on the observability host, one target per check, labelled `edge` and `check`, targets listed in a `file_sd` file rendered from one env var. A leg alert is gated on the edge's own `/healthz` so one broken edge pages once. The size floor of the CDN leg is enforced in the alert on `probe_http_uncompressed_body_length`, the stall bound by the probe deadline.
**Rejected**: (a) a body regexp as the size floor — Go regexps count runes, not bytes, and cap a repeat at 1000, so a binary object under the floor can match and one over it can miss; (b) a `Content-Length` header match — a transparently decompressed or chunked response has none, which would page on a healthy edge; (c) probing from the origin host's blackbox — when origin dies the edge probes die with it, and the edge→origin leg is the one that must stay visible then; (d) generating whole scrape jobs per edge into `prometheus.yml` — envsubst cannot loop, and a `file_sd` list reloads without a restart.

---

## 1. Business Context & User Value (JTBD)

### Problem Statement & Trigger
- **Trigger**: regional `edge` hosts (PR #51) carry a region's traffic to origin and to the CDN. Nothing watches them.
- **Pain Point**: an edge that is up but cannot reach origin, or whose CDN leg stalls after the first KB, is a regional outage invisible from origin; the mirror's public manifest being unreachable breaks the emergency read path silently.
- **Current Workaround**: users report it.

### User Journey & Workflow (Before vs After)
- **Before**: no signal; the operator curls the edge by hand.
- **After**: the operator lists edges in `SHRUTI_EDGE_HOSTS` on the observability host and redeploys; each edge gets three probes, alerts name the edge and the failing leg, and a dashboard shows up/latency/body size per leg next to storage-sync's pass counters.

### Value & Success Criteria
- **Primary Value Delivered**: an edge outage, an edge→origin outage and an edge→CDN outage or slowdown each page with the edge named; the mirror manifest is watched.
- **Observable Verification**: `probe_success{job="blackbox-edge-nodes"}` per `edge`/`check`; the alerts in the `edge-nodes` group.

---

## 2. Goals, Non-Goals & Scope Guardrails

### In-Scope Goals
- A blackbox exporter on the observability host with an edge module and a mirror-manifest module.
- `file_sd` targets rendered from `SHRUTI_EDGE_HOSTS` and `SHRUTI_MIRROR_CONFIG_URL` (both optional).
- Alerts: edge down, API leg failing, CDN leg failing or short, CDN leg slow, probe scrape failing, mirror manifest unreachable; `storage_sync_mirror_stale` revisited.
- A provisioned dashboard for edges, the mirror probe and storage-sync pass counters.
- Validation: rendering with 0 and 2 edges through `promtool check config`, `blackbox_exporter --config.check`, `promtool test rules` for the new alerts, and an end-to-end probe of a real edge between stub upstreams.

### Non-Goals
- A metrics endpoint for storage-sync (its counters are log fields; the dashboard reads them from Loki).
- A new notification channel or routing change.
- Changing the edge role, origin, or storage-sync code.
- Fixing unrelated alert rules (see Open questions in the PR).

### Decisions
| Question | Decision | Why |
| :--- | :--- | :--- |
| Where the edge probes run | A blackbox exporter on the observability host | Independent of origin; `/healthz/api` and `/healthz/cdn` exercise the edge→upstream legs from inside the edge, so no agent runs on the edge. Same image and version the agent already runs. |
| Target list | `file_sd` JSON rendered by `render-probe-targets.sh` from env | Zero edges renders `[]`: the jobs exist with no targets, no series, no alert. Entries are validated as `host[:port]`; anything else refuses the deploy. |
| Probe cadence | 60 s, scrape timeout 15 s, module timeout 10 s | The CDN probe moves a > 64 KB object per edge per probe; a minute keeps that small while `for: 2–3m` still means two or three consecutive failures. |
| CDN size floor | Alert on `probe_http_uncompressed_body_length < 65536` | Blackbox has no minimum; see Prior art. |
| Double paging | Leg alerts require the edge's `/healthz` success ratio to be at least 0.5 | An edge below 0.5 fails all three checks and pages once, as `edge_node_down`; between 0.5 and 0.75 `edge_node_down` and a failing leg can both page, by design. The gate sits below `edge_node_down`'s 0.75 so an edge failing one probe in four still has a dead leg paged: a gate equal to the down threshold drops the leg series whenever the ratio dips, and `for` never completes. |
| Flapping checks | Every edge rule reads a 5-minute success ratio, threshold 0.75 | An instant threshold with `for` resets on every success, so a check failing two probes in three, or every other probe, never pages; a ratio over five one-minute probes pages on two failures and not on one. Grafana also holds a series that drops out for two evaluations before resolving it, which promtool does not model; a ratio does not drop out on a single probe. |
| Observer outage | A `blackbox-reference` preflight (`OPTIONS /healthz` → `204`) that origin's Caddy answers itself; edge rules hold off only when the reference **and every edge's** `/healthz` fail together; API-leg rules hold off on the reference alone; `probe_reference_failing` (P2) pages | An origin app answers `GET /healthz`, so a reference behind it would mask every edge alert during an app outage. The preflight needs no change to the Caddy config. Requiring every edge to fail with it means an origin outage does not mask a dead edge while another edge is up. When every configured edge is down with origin — with a single edge, as on the first deployment, origin and that edge together — it is indistinguishable from an observer outage: edge alerts hold off, and `edge_unhealthy` and `probe_reference_failing` still page. An absent reference series suppresses nothing. |
| `tls_cert_expiring_soon` | `min by (job, edge)`, excluding `blackbox-mirror` and `blackbox-reference` | One alert per certificate we operate: origin's (seen by two jobs) and each edge's (seen by three checks). The mirror is served under its provider's certificate. |
| Existing `edge_unhealthy` | Scoped to `job="blackbox-edge"` | Its instance regex `https://.*/healthz` also matches every regional edge's `/healthz` and would page the origin alert for a regional outage. |
| `storage_sync_mirror_stale` | Expression kept, scoped to its job; annotation rewritten | `/readyz` goes stale after 3 × `SYNC_INTERVAL` without a successful pass of either kind. A pass fails when the walk or listing fails (the mirror is not advancing) or when any object fails; failed objects go to a retry set that every following pass retries, so only a failure persisting for three intervals pages — an object staying missing or outdated on the mirror, which is paged on purpose. The deep cadence adds no stale window, since a regular pass succeeding resets the budget and a deep pass costs what every pass cost before. The log counters are not a better signal: they are only written when a pass ends, so a wedged pass shows as silence, which `/readyz` already reports. |
| Mirror manifest check | `200` and a body that starts with `{` | Catches an error page served with `200`. |

---

## 3. Observable Acceptance Criteria (AC)

- [x] **AC-1**: With `SHRUTI_EDGE_HOSTS` empty and no mirror URL, the rendered `prometheus.yml` and target files pass `promtool check config`, and both target files are `[]`.
- [x] **AC-2**: With two edges, the edge target file holds six targets, `https://<edge>/healthz`, `/healthz/api`, `/healthz/cdn`, labelled `edge` and `check` (`healthz`, `api`, `cdn`), and `promtool check config` passes.
- [x] **AC-3**: A malformed edge entry (a path, a scheme, a quote, an empty or over-long DNS label, a port outside 1–65535) makes the renderer exit non-zero; unset variables render empty lists under `set -u`; entries split on commas and any whitespace including newlines, are lowercased and deduplicated.
- [x] **AC-4**: The observability blackbox config passes `blackbox_exporter --config.check`.
- [x] **AC-5**: Through a real edge between stub upstreams, the edge module reports success with a body ≥ 64 KiB on `/healthz/cdn`; a probe object under the floor reports its short length; a CDN leg that stalls past the budget fails within the budget.
- [x] **AC-6**: `promtool test rules` shows: `edge_node_down` fires for the failing edge only; `edge_node_api_leg_failing` and `edge_node_cdn_leg_failing` fire when the leg fails and the edge is up, and stay silent when the edge itself is down; `edge_node_cdn_leg_failing` fires on a short body with a successful probe; `edge_node_cdn_leg_slow` fires on sustained slow probes and not on one slow probe; a `/healthz` failing two probes in three pages `edge_node_down` and no leg alert; legs failing every other probe page; one failed probe per check does not; the reference and every edge failing together suppresses every edge alert and fires `probe_reference_failing`; the reference failing alone suppresses only the API legs and a dead edge still pages, also with the reference flapping; an edge failing one `/healthz` probe in four with a dead API leg pages the leg; `tls_cert_expiring_soon` fires exactly once per origin and edge certificate and not for the mirror's; `probe_scrape_failing` fires on `up == 0` for a probe job; `mirror_config_unreachable` fires after its `for`; `edge_unhealthy` ignores regional edges; `storage_sync_mirror_stale` fires on a stale `/readyz` and not on one failed probe.
- [x] **AC-7**: `check_alert_rules.py` refuses the rules if the edge group has no canary keyed on the probe jobs' `up`, if an edge leg alert is not gated with `and on (edge)` on the `/healthz` ratio, or if an edge alert does not end with the right suppression (the joint reference-and-all-edges clause; the reference alone for the API leg).
- [x] **AC-8**: The dashboard JSON is provisioned from `dashboards/json/` and parses.
- [x] **AC-9**: `infra/tests/validate-config.sh` exits 0.

---

## 4. Technical Risks, Failure Modes & Edge Cases

| Risk / Failure Vector | Impact | Mitigation Strategy in Code |
| :--- | :---: | :--- |
| Observability host network down | High | Reference probe fails with the edges; edge alerts hold off; `probe_reference_failing` pages. |
| Observability blackbox down | High | `up == 0` on the probe jobs → `probe_scrape_failing`; the per-edge rules go NoData → OK rather than paging every edge. |
| Zero edges configured | Medium | Empty target files; rules use `noDataState: OK`; the stack validates (AC-1). |
| Origin down | Medium | Every edge's API leg fails alongside `edge_unhealthy`; the annotation says to check origin first. |
| Probe traffic on the CDN | Low | One object per edge per minute. |
| Host list leaks into git | High | Hosts live in `config/shared.env` (gitignored); only placeholders are committed. |

---

## 5. Blast Radius & Target Files

| File | Action | Purpose & Scope |
| :--- | :---: | :--- |
| `infra/observability/compose/blackbox.yml` | CREATE | Edge and mirror-manifest modules. |
| `infra/observability/compose/docker-compose.yml` | MODIFY | `blackbox-exporter` service; target files mounted into Prometheus. |
| `infra/observability/compose/prometheus.yml.template` | MODIFY | `blackbox-edge-nodes`, `blackbox-mirror` jobs over `file_sd`. |
| `infra/observability/scripts/lib/render-probe-targets.sh` | CREATE | Env → target files. |
| `infra/observability/scripts/deploy.sh` | MODIFY | Render targets after templates. |
| `infra/observability/config/shared.env.example`, `.gitignore` | MODIFY | Placeholders; rendered targets ignored. |
| `infra/observability/compose/grafana/provisioning/alerting/rules.yml` | MODIFY | `edge-nodes` group, mirror rule, `edge_unhealthy` and `storage_sync_mirror_stale` scoping. |
| `infra/observability/compose/grafana/provisioning/dashboards/json/shruti-edges.json` | CREATE | Dashboard. |
| `infra/tests/lib/check_alert_rules.py` | MODIFY | Edge guards; Prometheus-form export for unit tests. |
| `infra/tests/alerts/*.test.yml` | CREATE | `promtool test rules` cases. |
| `infra/tests/validate-config.sh` | MODIFY | Rendering, blackbox check, rule tests. |
| `infra/tests/edge-probe-e2e.sh` | CREATE | Blackbox through a real edge. |
| `.github/workflows/infra-observability.yml` | MODIFY | Runs the probe e2e. |
| `infra/observability/README.md`, `docs/repos/shruti/architecture/observability.md` | MODIFY | What is probed, how to add an edge. |

---

## 6. Phased Execution Plan

### Phase 1: Red
- [x] Rule tests, validate-config assertions and the probe e2e written; each run fails against the unmodified stack.

### Phase 2: Green
- [x] Blackbox config, compose, template, renderer, rules, dashboard.

### Phase 3: Wiring
- [x] `deploy.sh`, env example, `.gitignore`, CI, docs.

### Phase 4: Gate
- [x] Hand mutation check of each new test and alert.
- [x] Full gate below.

---

## 7. Verification Gate

```bash
infra/tests/validate-config.sh
infra/tests/edge-probe-e2e.sh
infra/tests/chat-metrics-e2e.sh
```
