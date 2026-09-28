# Profile sync — library_items repair

`profile repair-sync` fixes `library_items` documents whose change log would leave installed apps on the wrong state. Installed clients apply pulled `library_items` rows in `global_seq` order and take each one wholesale; the server's master is the row with the highest `hlc`. Before `profile` gated server-authored writes on hlc, a late or redelivered lower lifecycle event (say `processing` after `ready`) was appended as the newest row, and devices rolled back to it; a publish flip could also merge that stale state. The fixed service can no longer produce such rows; this command repairs the ones already in the database. It lives in the regular `shruti-profile` image, next to `profile migrate`. See [Profile sync](../architecture/profile-sync.md) and [Personal library](../architecture/personal-library.md).

## What it does

It reads only server-owned collections (today `library_items`) and reports two kinds of document:

| Reason | Meaning | Corrective row carries |
|---|---|---|
| `misordered` | newest row by `global_seq` ≠ highest-hlc row | the highest-hlc row's op and data |
| `stale_publish` | the highest-hlc row is a publish flip whose data is not the earlier master merged with `origin=published` | the earlier master merged with `origin=published` |

The corrective row is stamped with the stamp just above the highest one: the same physical, counter + 1 (`hlc.Successor`). For a lifecycle state that sits between that state and the next rank, so later lifecycle events still win. For a published document it is `999999999999999:00001:server:orchestrator` — nothing but a higher counter sorts above `Terminal`. The row becomes both the newest row by `global_seq` and the master, so devices converge on the next pull, and a second run finds nothing.

Without `--apply` the command only reads. With `--apply` each document is written in its own transaction under the same per-user advisory lock as the service, after re-planning against the current rows, so it is safe while `profile` is serving.

## Before you start

1. **The fixed `profile` image is deployed.** Run the repair only after it. The old image can still append a misordered row after the repair.
2. **Check for legacy stamps (read-only).** `library_items` stamps are small rank numbers or the terminal constant. A physical field in between means a row from before rank-ordered stamps; lifecycle events below such a stamp are now dropped:

   ```sh
   docker compose exec -T profile-postgres psql -U profile -d profile -c \
     "SELECT count(*) FROM profile.changes
       WHERE collection = 'library_items'
         AND substr(hlc, 1, 15)::bigint BETWEEN 1000000 AND 999999999999998;"
   ```

   Expect `0`. Anything else: stop and escalate, do not apply.
3. **Back up the two tables the repair writes:**

   ```sh
   docker compose exec -T profile-postgres pg_dump -U profile -d profile \
     --format=custom -t profile.changes -t profile.library_items > profile-pre-repair.dump
   ```

   The nightly backup covers only the main database, not `profile-postgres`.

Run the commands below from the compose directory on the origin host (the one `deploy.sh` drives).

## 1. Dry run

```sh
docker compose --profile origin run --rm --no-deps profile repair-sync
```

Add `--user <uuid>` to look at one account. One tab-separated line per document, then a total:

```text
planned  misordered  <user>  library_items  <doc>  newest=412@…0002:00000:…  master=398@…0003:00000:…  repair=upsert@…0003:00001:…  status=processing,origin=- -> status=ready,origin=-
dry-run: 1 document(s) planned
```

Only `status` and `origin` are printed; the output still names user ids, so keep it off shared channels.

## 2. What to check

- The count is plausible: a handful of documents, not a large share of `library_items`.
- `misordered` lines go forward, never back: `processing -> ready`, `queued -> failed`, `… -> deleted`. A line that goes backwards (`ready -> processing`) is a bug in the plan — stop.
- `stale_publish` lines end in `origin=published`, usually with `status=ready`.
- Every `repair=` stamp is above `master=`, and on published documents starts `999999999999999:00001`.
- Spot-check one document read-only:

  ```sh
  docker compose exec -T profile-postgres psql -U profile -d profile -c \
    "SELECT global_seq, op, hlc, data->>'status', data->>'origin' FROM profile.changes
      WHERE user_id = '<user>' AND collection = 'library_items' AND doc_id = '<doc>'
      ORDER BY global_seq;"
  ```

## 3. Apply

```sh
docker compose --profile origin run --rm --no-deps profile repair-sync --apply
```

It prints the plan, then one `applied` line per document written. A document the service changed in the meantime is re-planned, and skipped if it no longer needs repair, so `applied` can be shorter than `planned`. On an error it stops, exits 1 and keeps what it already committed; fix the cause and run it again.

Run the dry run once more afterwards: it must report `0 document(s) planned`.

## Rollback

The corrective rows carry the state the server already treats as the master, so rolling back is rarely what you want.

- Devices that pulled a corrective row keep the corrected state. Removing the row from the server does not undo that, and their cursors are already past it.
- Corrective rows are the only `library_items` rows with a non-zero counter field:

  ```sql
  SELECT global_seq, user_id, doc_id, hlc FROM profile.changes
   WHERE collection = 'library_items' AND device_id = 'server:orchestrator'
     AND substr(hlc, 17, 5) <> '00000';
  ```

  Deleting them brings the server log back to its pre-repair shape.
- `stale_publish` repairs also rewrite the `library_items` projection. To restore it, `pg_restore --data-only -t library_items` from `profile-pre-repair.dump` into a scratch database and copy the affected rows back.
