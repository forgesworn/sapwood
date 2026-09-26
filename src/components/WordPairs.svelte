<script lang="ts">
  // The five-word compare, shown once in `confirm` and again (unmoved) in
  // `working`: never break a word across lines, group in pairs, whole numbers
  // read like handwriting (no dotted/slashed confusion with letters).
  interface Props {
    words: string[]
  }
  let { words }: Props = $props()
</script>

<ol class="word-pairs">
  {#each words as word, i (i)}
    <li><span class="word-no">{i + 1}</span> <span class="word">{word}</span></li>
  {/each}
</ol>

<style>
  .word-pairs {
    list-style: none; margin: 0.6rem 0; padding: 0;
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem 0.9rem;
  }
  .word-pairs li {
    display: inline-flex; align-items: baseline; gap: 0.35rem;
    white-space: nowrap;
  }
  /* Wider gap after the 2nd and 4th word: three visual groups of "1-2 / 3-4 / 5",
     matching the board's own paging. */
  .word-pairs li:nth-child(2n) { margin-right: 0.5rem; }
  .word-no { font-size: 0.8rem; color: var(--text-muted); }
  .word {
    font-size: 1.5rem; font-weight: 600; color: var(--green);
    white-space: nowrap; word-break: normal; font-variant-numeric: slashed-zero;
  }
</style>
