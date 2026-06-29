In **Settings**, tap the row with your account and pick **Delete account**.
The app then asks what to do with the data on this device.

## What happens

- On our servers we immediately remove: your email, the links to Google and
  Apple, and the diagnostic traces from your chat requests.
- On the device you pick one of two options:
  - **Delete account and wipe data** — the app returns to a clean state:
    your playlist, notes, downloaded audio and chat history on this phone
    are cleared.
  - **Delete account, keep my data** — everything local stays put and the
    app keeps working in anonymous mode.

Either way you are signed out. You can sign in again with the same Google
or Apple account, but on our side it will be a new account.

## What can't be deleted

Messages you have already sent through chat go through an external LLM
provider (OpenRouter / Google Gemini). Those services keep them under
their own rules — typically up to 30 days for abuse protection. We have
no access to their storage.

Subscription purchase records stay with Apple or Google — we can't remove
those either.

For the full details, see the [privacy
policy](https://jiva-studio.github.io/lectorium/).
