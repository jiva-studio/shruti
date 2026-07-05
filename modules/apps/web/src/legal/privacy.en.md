# Privacy Policy

_Effective date: July 5, 2026_

This privacy policy applies to the Shruti app (hereby referred to as "Application") for mobile devices that was created by Aleksei Leontev (hereby referred to as "Service Provider") as a free service. The Application includes an optional paid subscription and an optional user account. This service is intended for use "AS IS".

## What information does the Application obtain and how is it used?

The Application does not require registration to use the free features. Personal data is processed only when you opt in to a specific feature — purchasing a subscription, signing in with Apple or Google, or using the in-app chat.

If you choose to sign in with Apple or Google, the following data is processed:

- **Email address** — returned by the identity provider and stored on our backend to identify your account on subsequent sign-ins and across devices.
- **Name** — returned by Apple on first sign-in only (Apple Sign in allows you to share or hide your real name; what you choose there is what we receive). Stored once and not overwritten on subsequent sign-ins. Google does not provide a name unless granted by you.
- **Profile picture URL** — Google only, used to display your avatar in the app.
- **Provider identity** — the opaque user id from Apple or Google, used to link future sign-ins to the same account.

Signing in is fully optional. The Application works anonymously without an account.

If you choose to purchase or restore a subscription, the following data is processed:

- **Purchase history** — which subscription products you have bought, renewed, or cancelled. Used to grant access to paid features and to restore your subscription after reinstalling the Application.
- **Anonymous user identifier** — a random identifier generated on your device and stored by our subscription provider. It is not linked to your name, email, or any account you control.
- **Device identifier** — used by Apple and Google to verify purchase receipts and prevent fraud. The Application itself does not store or use this identifier for any other purpose.

This data is used solely to operate the subscription feature. It is not used for advertising, profiling, or cross-app tracking.

## Does the Application collect precise real time location information of the device?

This Application does not collect precise information about the location of your mobile device.

## In-app chat ("Ask Sadhu") and AI features

The Application includes an optional chat feature that answers questions about the lecture library using a large language model (LLM). When you send a message, the following is processed:

- **Message text** — the question you typed, plus relevant excerpts retrieved from the lecture library, are sent to the LLM to generate an answer.
- **Session identifier** — a random per-conversation id used to keep the dialogue coherent across turns. It is not linked to your name or email.
- **Optional feedback** — if you tap thumbs-up / thumbs-down on a reply, that rating is stored alongside the corresponding turn.

Chat traffic is routed through **OpenRouter, Inc.** (the LLM gateway) to **Google Gemini** models operated by Google. No other LLM provider currently receives your chat messages. Chat content is used solely to produce the reply you see and to improve the quality of the feature; it is not used for advertising or profiling.

To find the lecture excerpts relevant to your question, the text of your message is also passed through OpenRouter to **OpenAI's** `text-embedding-3-small` model, which converts the text into a numerical vector used for semantic search over the lecture library. Only the message text is sent; no account identifiers, history, or device data accompany the embedding request.

We additionally record each chat turn — your message, the retrieved excerpts, the model's reply, and timing information — into **Langfuse**, an open-source observability tool we run on our own infrastructure. Langfuse is used solely to debug answer quality and to investigate failures. The data does not leave our servers and is not shared with any third party.

## Where chat requests are processed

Our chat backend runs in one global location. Devices outside Russia connect to it directly. Devices in Russia connect through a reverse-proxy hosted on a Russia-based VPS that forwards the request to the same backend; the response streams back along the same path. The proxy does not modify the message content — it only attaches a server-side marker identifying the request as originating in Russia.

For requests with that marker, the backend's persistence rules are:

- free-text feedback comments are not stored;
- message bodies do not appear in access logs;
- the user identifier in Langfuse observability traces is a one-way salted hash, so traces cannot be linked back to a specific account.

The chat content itself travels to OpenRouter and Gemini for the response to be generated, exactly as described in "In-app chat" above. The rules above apply only to long-term persistence on our own infrastructure.

## Diagnostic logs and chat records

To keep the service running and to improve answer quality, the Application's backend keeps:

- **Service logs** — request metadata, error records, and performance timing. These do not include your chat messages.
- **Chat records** — your messages, the excerpts we found, and the model's reply for each turn. Used to debug answer quality and improve the system.

Both live on infrastructure we operate ourselves — they are not shared with any third-party analytics or observability service. Service logs are kept for up to 30 days; chat records for up to 90 days. When you delete your account, your chat records are removed right away — see the _Account deletion_ section below.

## Syncing your data across your devices

If you are **signed in** with Apple or Google, the Application stores a copy of your own app data on our servers so it stays in sync across every device signed in to the same account, and so it can be restored if you reinstall the Application or switch devices. For a signed-in account we store and sync:

- **Your library** — the tracks and playlists you have added or saved.
- **Listening history** — which lectures you have played, and your playback progress.
- **Notes** — the timecoded notes you write on lectures.
- **Chat history** — the "Ask Sadhu" conversations you start (your messages and the model's replies), so you can continue them on another device.

This data is tied to your account and stored on infrastructure we operate ourselves; it is not shared with any third-party analytics or advertising service. Downloaded audio files and on-device settings are **not** synced — downloads stay on the device that made them. We keep this synced data until you delete it or delete your account (see the _Account deletion_ section below). This synced chat history is separate from the diagnostic **chat records** described in _Diagnostic logs and chat records_ above: those diagnostic records exist only to debug answer quality and are automatically purged on the roughly 90-day schedule, whereas your synced conversations are your own and are kept for cross-device continuity until you delete them or your account. If you are also signed in on our website at **shruti.app**, your synced conversations may additionally appear in the web "Ask Sadhu" chat there, where they are shown read-only.

**Chat sync is optional.** Syncing your chat history is on by default, but you can turn it off at any time in the app's chat settings ("Sync chats"). Only conversations you start yourself are ever synced; automatic and system-generated messages are never sent to our servers for syncing.

**Anonymous use stays on your device.** If you use the Application without signing in, none of this data is sent to our servers — your library, listening history, notes, and chats live only on your device until you choose to sign in. Signing in is what turns syncing on.

## Crash and error reporting

To detect and fix crashes and bugs, the Application sends automatic crash and error reports from your device to **Sentry**, an error-monitoring service operated by Functional Software, Inc. (dba Sentry). A report is generated only when the app crashes or hits an unexpected error, and contains:

- **Error details** — the error type, message, and the stack trace showing where in the code it occurred.
- **Device and app information** — device model, operating-system version, app version/build, and language.
- **A short trail of recent in-app events** ("breadcrumbs") leading up to the error — for example which screens were opened or which background operation failed.

These reports **do not** include your name, email address, chat messages, or search queries. Email addresses are stripped from reports before they leave your device, and we have disabled Sentry's automatic collection of your IP address. A report may contain opaque technical identifiers (such as an anonymous user or device id) used only to group related errors; these are not linked to your name or email. This data is used solely to keep the Application stable and is not used for advertising, profiling, or tracking. Reports are processed by Sentry in the United States. [Sentry Privacy Policy](https://sentry.io/privacy/).

## Sub-processors

The Application relies on a small set of third parties — each is engaged only for the feature noted, and only the data listed is shared. No other third party receives any data from the Application.

- **RevenueCat, Inc.** (subscriptions) — verifies in-app purchases, manages entitlements, and powers the restore-purchase flow. Receives the purchase receipt and an anonymous random identifier minted on your device (`$RCAnonymousID:...`). This identifier is _not_ linked to your Shruti account id, name, or email. [RevenueCat Privacy Policy](https://www.revenuecat.com/privacy).
- **Apple Inc.** (on iOS) and **Google LLC** (on Android) — process the actual purchase transaction and issue the verification receipts. **Apple** additionally provides the Sign in with Apple flow when you choose it. **Google** additionally provides the Sign in with Google flow when you choose it. Their handling of this data is governed by their respective privacy policies.
- **OpenRouter, Inc.** (in-app chat) — LLM gateway that forwards your chat prompts and the retrieved lecture excerpts from our backend to the underlying model provider, and returns the reply. Also routes embedding requests to OpenAI for semantic search over the lecture library. [OpenRouter Privacy Policy](https://openrouter.ai/privacy).
- **Google LLC** (in-app chat) — operates the Google Gemini models that currently generate the chat reply downstream of OpenRouter. [Google Privacy Policy](https://policies.google.com/privacy).
- **OpenAI, L.L.C.** (in-app chat) — operates the `text-embedding-3-small` model that converts your chat message into a search vector used to retrieve relevant lecture excerpts. Reached through OpenRouter; only the message text is sent. [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy).
- **Functional Software, Inc. (dba Sentry)** (crash & error reporting) — receives automatic crash and error reports from the app: the error and its stack trace, device / OS / app-version information, and a short trail of preceding in-app events. Does not receive your name, email, chat messages, or search queries. [Sentry Privacy Policy](https://sentry.io/privacy/).

Our own diagnostic logs, chat records, and Langfuse observability traces run on infrastructure we operate ourselves — they are _not_ third-party sub-processors.

## Anonymous use

If you use the app without signing in, we still need a stable device-only identifier to recognise you across sessions (for example, to remember your subscription receipts). That identifier and any server-side data tied to it are automatically deleted after 12 months of inactivity. If you sign in at any point, this data becomes part of your account and is governed by the _Account deletion_ rules below.

## Account deletion

If you signed in with Apple or Google, you can delete your account at any time from inside the Application: **Settings → Account → Delete Account**. The button is shown only while you are signed in.

What we delete from our servers when you tap Delete Account:

- Your account (id, email, name, profile picture link).
- The Apple and Google sign-in links attached to that account.
- All active sessions — every device signed in to the account is logged out.
- Your chat history with our service (your messages, the excerpts we found, the model's replies) and any related counters.
- Everything we synced across your devices — your library, listening history, notes, and any chat conversations you chose to sync. All of it is erased from our servers with no retention.

What stays on your device — and is your choice during the deletion flow — is the local data the Application has cached for you: chats, notes, playlists, downloaded audio, and listening history. You can wipe this local data as part of account deletion, or keep it and continue using the Application anonymously.

What we cannot delete on demand: messages sent during chat use travel through [OpenRouter](https://openrouter.ai/privacy) to the language-model provider — currently [Google's Gemini models](https://policies.google.com/privacy). Those providers keep the messages for a short period (typically up to 30 days) under their own anti-abuse policies. Purchase records that Apple or Google retain for the duration of those platforms' own policies are likewise outside our control.

## What are my opt-out rights?

You can stop all collection of information by the Application easily by uninstalling it. You may use the standard uninstall processes as may be available as part of your mobile device or via the mobile application marketplace or network. If you signed in with Apple or Google, you can additionally delete your account and associated server-side data from inside the Application — see the _Account deletion_ section above. You may also email the Service Provider at [support@jiva.studio](mailto:support@jiva.studio) for any other data-removal request; note that records required by Apple or Google for purchase verification cannot be removed for the duration mandated by those platforms.

## Subscription management

Subscriptions are managed entirely by Apple or Google. To view, cancel, or change a subscription, use the subscription settings of your App Store or Google Play account. Cancelling does not delete the subscription history retained by Apple or Google.

## Children

The Application is not used to knowingly solicit data from or market to children under the age of 13.

The Service Provider does not knowingly collect personally identifiable information from children. The Service Provider encourages all children to never submit any personally identifiable information through the Application and/or Services. The Service Provider encourages parents and legal guardians to monitor their children's Internet usage and to help enforce this Policy by instructing their children never to provide personally identifiable information through the Application and/or Services without their permission. If you have reason to believe that a child has provided personally identifiable information to the Service Provider through the Application and/or Services, please contact the Service Provider ([support@jiva.studio](mailto:support@jiva.studio)) so that they will be able to take the necessary actions.

## Security

The Service Provider is concerned about safeguarding the confidentiality of your information. All data transferred to subscription processors is encrypted in transit over HTTPS. The Application stores no payment card data — payments are handled exclusively by Apple and Google.

## Changes

This Privacy Policy may be updated from time to time for any reason. The Service Provider will notify you of any changes to their Privacy Policy by updating this page with the new Privacy Policy. You are advised to consult this Privacy Policy regularly for any changes, as continued use is deemed approval of all changes.

This privacy policy is effective as of July 5, 2026.

## Your Consent

By using the Application, you are consenting to the processing of your information as set forth in this Privacy Policy now and as amended by the Service Provider.

## Contact Us

If you have any questions regarding privacy while using the Application, or have questions about the practices, please contact the Service Provider via email at [support@jiva.studio](mailto:support@jiva.studio).
