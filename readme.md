# Jira Diff Highlighter

Jira Diff Highlighter is a cross-browser extension (Chrome & Firefox) that enhances the readability of Jira issue history diffs. It provides Git-style line diffs and side-by-side comparisons with highlighted changes, including custom fields such as Acceptance Criteria and Product Copy.

## Features
- **Git-Style Diff View**: Shows added and removed lines with line numbers, hunk headers, and highlights within modified lines. Preserves whitespace and rich-text line breaks.
- **Configurable Preview**: Keep Jira's original values, or choose Git-style side-by-side or unified diffs, showing changed lines or all lines. The default is side-by-side with only changed lines; configure zero to twenty context lines in the popup.
- **Raw Formatting**: Preserves literal heading markers, asterisks, indentation, and trailing spaces. Rendered headings are represented as plain hashtag-prefixed text.
- **Expandable Context**: Show hidden unchanged sections or switch an individual preview to all lines without changing your saved preference.
- **Custom Field Support**: Enhances any field update displayed as old and new values in the activity history, including fields being populated or cleared. No field-name configuration is needed.
- **Activity Controls**: Keeps All, Comments and History visible when Jira places filters behind More. Starts each issue with All by default; choose a different default or disable the shortcuts in the popup. Other activity types remain available in More.
- **Highlighted Changes**: Color-codes additions, deletions, and modifications for quick identification.
- **Configurable Large Change Handling**: Collapses large insertions and deletions above your chosen character limit, with one-click access to show the full text.
- **Toggle Functionality**: Easily switch between enhanced and original diff views.
- **Rovo Change Previews**: When Jira Rovo shows a change-acceptance card, adds a read-only large diff preview and keeps acceptance with Jira's own controls. Disable this with **Show Rovo change previews** in the popup.
- **Multi-Tab Support**: Maintains consistent state across multiple Jira tabs.
  
---

## Installation
| Browser | Link |
|---------|------|
| **Chrome / Edge** | [Chrome Web Store](https://chromewebstore.google.com/detail/jira-diff-highlighter/imlebnoogjdcbkaaighofkpfciamehni) |
| **Firefox** | [Mozilla Add-ons](https://addons.mozilla.org/firefox/addon/jira-diff-highlighter/) |

---

## Usage

- The extension automatically enhances diff views on Jira pages.
- Open an issue's **History** tab (or **All** activity view) to see previews for Description and custom-field updates. Jira must display the old and new values; the extension does not fetch hidden history values.
- Use the extension's toggle button to switch between enhanced and original views. An individual preview can also switch temporarily from **Original values** to **Git diff**.
- Choose **Diff preview** in the popup: **Original Jira values**, **Git side-by-side - changed lines** (default), **Git side-by-side - all lines**, **Git unified - changed lines**, or **Git unified - all lines**. Side-by-side diffs align corresponding lines and use empty cells for additions and deletions.
- **Context around changes** defaults to `0` for strictly changed lines. Set it to `3` for the usual Git context, or any value up to `20`. Use **Show all lines** or **Show unchanged lines** inside a preview to expand it temporarily.
- Existing saved preview choices are retained after an update; select **Git side-by-side - changed lines** to switch an existing installation to the new default view.
- Set the large change limit from the extension popup. The default is 500 characters, and collapsed changes can be expanded inline with "Show full text".
- Rovo work-item update cards include one **View full diff** button beside **Dismiss** and **Accept all**. Hover a suggested field first so Jira renders its current and suggested values, then click the footer button. The extension captures the full tooltip text, including lines Jira visually clips, and retains it after the hover preview closes. For cards with several fields, choose a field inside the full preview. The diff lines scroll independently beneath the preview controls. Accept or dismiss updates with Jira's native controls.
- Disable **Show Rovo change previews** in the extension popup if the acceptance card should stay untouched.
- The extension works on Atlassian-hosted Jira pages by default. Custom Jira domains can be enabled from the extension popup with per-site access.
- If Chrome reports that it cannot access a page, open the extension's **Details → Site access**, allow your Jira site, and refresh Jira. Automatic injection after an extension reload skips sites without granted access.

---

## Devlopment / Building from Source
npm install

Run the history preview regression tests with `npm test`.

#### Live-reload dev session
```
npm run dev:chrome       # opens Chrome/Edge with hot reload
npm run dev:firefox      # opens a temp Firefox with hot reload
```

#### Production packages
```
npm run build:chrome     # → jira-diff-highlighter.zip
npm run build:firefox    # → web-ext-artifacts/*.zip
```
