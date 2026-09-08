/**
 * Cross-view state for the single background inquiry session (pty id 'inquiry').
 *
 * The Inquiries modal owns the terminal, but the pty outlives the modal — so
 * the toolbar needs to know a Claude is still working somewhere and offer a way
 * back to it. Kept here rather than in App.svelte so both sides can write it.
 */
export const inquiryRun = $state({
  running: false,
  slug: null as string | null,
  title: ''
})
