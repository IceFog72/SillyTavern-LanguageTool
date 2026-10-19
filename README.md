# LanguageTool Grammar Checker (SillyTavern extension)

Underlines spelling and grammar issues in SillyTavern text boxes using [LanguageTool](https://languagetool.org/), with click-to-fix suggestions.

> **Requires a server plugin.** This extension only provides the UI. It talks to a companion
> SillyTavern server plugin that exposes `/api/plugins/languagetool/status` and
> `/api/plugins/languagetool/check`. Server plugins must be enabled in SillyTavern's `config.yaml`.
> Install the [LanguageTool server plugin](https://github.com/IceFog72/SillyTavern-LanguageToolPlugin)
> separately and enable server plugins in `config.yaml`.

## Install

In SillyTavern open **Extensions → Install extension** and paste this repository's URL, then reload.

## Features

- Highlights issues directly in the text box (red = spelling, amber = grammar).
- Click a highlighted word, or the badge in the corner of the box, to see suggestions. `Esc` closes the panel.
- Replacements keep your undo history (`Ctrl+Z`).
- **Ignore word** button for names, places and invented words; manage the list in settings.
- Ignores `{{macros}}`, HTML tags, URLs and `inline code` (can be turned off).
- Check any text box: set one CSS selector per line (default `#send_textarea`).
- Multiple languages per check (up to 8), or auto-detect.
- Password fields are never checked or sent anywhere.

## Settings

| Setting | Description |
| --- | --- |
| Enable grammar checking | Master switch. |
| Languages to check | One or more LanguageTool language codes, or *Auto-detect*. |
| Text inputs to check | CSS selectors, one per line. |
| Ignore macros, HTML tags, URLs and inline code | Hides issues found inside such text. |
| Ignored words | Spelling issues for these words are hidden. |
| Check delay | Milliseconds to wait after you stop typing. |

Longer text is checked in chunks of approximately 20,000 characters.

## License

<!-- TODO: add a LICENSE file (the SillyTavern docs suggest AGPLv3 if unsure). -->
