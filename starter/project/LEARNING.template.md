---
id: learning-0123456789ab
title: "One line that names the lesson"
paths: ["src/example/**", "test/example.test.mjs"]
kind: procedure
enforced_by: none
last_verified: 2026-01-01
retire_when: none
---

What a later agent working on these paths should know, in plain sentences: the mistake, why it
happens here, and what to do instead. At most 1,500 characters for the whole file, this
frontmatter and the title included.

Keep the frontmatter exactly as above: these seven fields, one per line, in this order, the title
as one JSON string and the paths as a JSON list of quoted globs (a space after each comma, or none,
is fine), then a blank line, the body, and one final newline.
