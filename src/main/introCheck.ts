import { promises as fs } from 'fs'
import { join, resolve } from 'path'

// --- intro-check skill -------------------------------------------------------

const SKILL_DIR = join('.claude', 'skills', 'intro-check')
const SKILL_REL = join(SKILL_DIR, 'SKILL.md')
const GUIDE_REL = join(SKILL_DIR, 'GUIDE.md')

/**
 * The `intro-check` skill: audits the front end of `manuscript.qmd` (hook, gap,
 * theory, hypotheses, introduction plan) against `GUIDE.md`, an editorial guide
 * distilled from the paragraph-level anatomies of Anding (2026, JAE), Cheng, Li
 * & Lin (2026, RAST) and Tillet (2026, JAR). Read-only by default: it reports,
 * and only edits the manuscript when the user asks.
 */
export function introCheckSkill(): string {
  return `---
name: intro-check
description: Check the front end of the manuscript (hook, gap, theory, hypotheses, introduction) against the framing guide and report what a referee would flag
---

You are auditing the **front end** of \`manuscript.qmd\`: the introduction and the
theory / hypothesis development section. Ignore the empirics (design, results,
robustness) except where the front end makes a promise they must keep.

The rubric is \`GUIDE.md\` in this skill's folder. Its core claim: frame the paper
as a test of a regulator's own promise — state the promise, show it is untested
where it matters, give a theory for why it may come at a hidden cost, and write
the hypotheses as that trade-off.

## Steps

1. Read \`GUIDE.md\` (this folder) in full.
2. Read \`manuscript.qmd\`. Locate the introduction and the theory / hypothesis
   section. If the user names a section or passes a paragraph range, check only that.
   Number the introduction's paragraphs ¶1, ¶2, … so you can point to them.
3. **Spine test.** Read only the first and last sentence of the introduction. Can
   you name (a) the promise, (b) the hidden cost, (c) the answer? Write down what
   you get, or say what is missing.
4. **Classify the front end:**
   - Hook: institutional or literature-led? The number? Where does the RQ land?
   - Gap type: scope, observability, linkage — or a plain "no one has studied X"?
   - Theory approach: argued causal chain, borrowed formal model, or two-sided
     theory with one side chosen? Is the theory or construct named?
   - Hypothesis pattern: A (for/against/resolve/moderators), B (premises/framework/
     joint test), C (one argument, opposite signs) — or none consistently?
5. **Run the checklist** from \`GUIDE.md\` ("Checklist before submission"). For each
   item give ✅ / ⚠️ / ❌, the ¶ or section where you found it (quote ≤ 1 sentence),
   and for anything not ✅ a concrete fix — ideally a rewritten sentence using the
   matching template from the guide, in the manuscript's own terms.
6. **Pitfall scan.** Check each row of the guide's "Pitfalls to avoid" table and
   report only the ones that occur.
7. **Paragraph map.** Map each intro paragraph to the job it does in the guide's
   paragraph-by-paragraph table. Flag paragraphs that do no job (candidates to cut),
   jobs with no paragraph, and order problems. The table is a suggestion, not a law:
   flag a deviation only when it costs the reader something.

## Report

Lead with a three-line verdict: the spine as it stands, the single biggest
problem, and the fix that would most improve the paper. Then the classification,
the checklist, the pitfalls, the paragraph map. Keep it tight; quote the
manuscript rather than paraphrase it.

## Rules

- **Do not edit \`manuscript.qmd\`** unless the user asks. When they do, follow
  \`.claude/CLAUDE.md\` and \`LEARNED_EDITS.md\`, and keep \`[@key]\` citations intact.
- Never invent citations, calls for research, regulator quotes or numbers. When a
  fix needs one (e.g. "quote the regulator's goal", "cite the call with a
  pinpoint"), say what kind of source is needed and mark it \`[SOURCE NEEDED]\`;
  check \`references.bib\` for a candidate key first.
- The guide's examples (Anding, Cheng, Tillet, P-numbers) are illustrations. Do
  not cite those papers in the manuscript unless they are actually relevant and in
  \`references.bib\`.
`
}

export function introCheckGuide(): string {
  return `# How to frame an accounting paper

Frame the paper as a test of a regulator's own promise: state the promise, show it is untested where it matters, give a theory for why it may come at a hidden cost, and write the hypotheses as that trade-off.

This guide covers the front end only: hook, gap, theory and hypotheses. It draws on the paragraph-level anatomies of three recent papers:

- **Anding (2026, JAE)**, "Navigating new accounting standards"
- **Cheng, Li & Lin (2026, RAST)**, "Attention to detail: how do information users process exhibits in Form 10-K?"
- **Tillet (2026, JAR)**, "Revenue Recognition Comparability and Analysts' Disclosure Processing Costs"

Paragraph references (P003 etc.) point to the coded paragraphs in each paper's anatomy.

## The spine: one argument, not four sections

Write the hook, gap, theory and hypotheses as four steps of a single argument. All three papers do this.

1. **The regulator promises X.** Quote the promise in the regulator's own words.
2. **X has not been tested where it matters.** The evidence covers narrow cases, aggregates, or only one link of the chain.
3. **Theory says X may come with a hidden cost.** A named theory, applied to the setting, predicts a trade-off next to the intended benefit.
4. **The hypotheses turn the trade-off into signs.** Each prediction has a direction, a counter-argument and, where it helps, what a null would mean.

If a paragraph in the front end does not move one of these four steps forward, cut it or move it to a footnote.

**Test of the spine:** a reader who sees only the first and last sentence of the introduction should be able to name the promise, the hidden cost and the answer.

## The hook: open on the institution, not the literature

Open paragraph 1 with what a regulator claims or requires, add one striking number, and end the paragraph with the research question.

| Paper | Institutional opening | The number | Where the RQ lands |
| --- | --- | --- | --- |
| Anding | The FASB's own cost–benefit claim for its standards | "More than 15 standards a year" | Last sentence of P003 |
| Cheng | The 10-K defined by contrast: curated summary vs. unfiltered exhibits | Exhibits are "nearly one-fourth of the total 10-K length" | Last sentence of P003 |
| Tillet | "For decades" standard setters have stressed comparability; SFAC No. 2 epigraph | ASC 606 took 12 years, 650 outreach meetings, 1,500 comment letters | Two literal questions at the end of P003 |

**Suggestions**

- **Quote the regulator's goal.** It makes the paper a test of a stated promise, which referees and editors read as policy-relevant by construction.
- **Use one number, not five.** One statistic that shows scale (frequency, share, effort) does more than a paragraph of descriptives.
- **Present the setting as a laboratory.** Cheng's abstract: "Form 10-K offers a setting for studying how users process complex, multi-layered disclosures." The question then reaches beyond the setting.
- **Justify a narrow scope with the regulator's words.** Tillet's epigraph says comparison needs focus on one or two characteristics, then: "I focus on a single component … —revenue—to pose two questions."

**Templates**

- "For decades, [regulators] have emphasized [construct]. … In this study, I focus on a single [component] of [information]—[X]—to pose two questions. First, …? Second, …?" (Tillet)
- "Despite their seemingly low visibility within [bundle], [component] [is] substantial—comprising [share] of [total]. We examine how [users] allocate attention within this [bundle]." (Cheng)
- "[Setting] offers a setting for studying how [general process] works when [condition]." (Cheng)

## The gap: the promise is untested where it matters

State the gap as an untested regulatory promise, then name which kind of gap it is. A plain gap in the literature ("no one has studied X") is the weakest version.

| Gap type | What is missing | Example | Template |
| --- | --- | --- | --- |
| **Scope** | Evidence exists for prominent cases or targeted outcomes, not the general class or the overall outcome | Anding: single standards and targeted quality are studied; the flow of standards and overall quality are not | "Prior research has provided insights about [prominent cases], but there is a paucity of evidence about whether [general class] satisfies [the regulator's stated intent]." |
| **Observability** | The construct is accepted but its workings could not be seen | Cheng: limited attention is established; how users allocate it within a disclosure is not, "due to the difficulty of observing" processing | "Despite compelling evidence in support of [X], research on how [Y] remains scant, due to the difficulty of observing [Z] (see [review], Section [n])." |
| **Linkage** | Each link exists on its own; the chain is untested | Tillet: few studies isolate a standard's effect on comparability *and link* it to users' processing costs | "Prior studies show that [benefit], yet few studies empirically isolate the effects of [standard] on [construct] and link [it] to [user outcome]." |

**Suggestions**

- **Join the gap to the regulator's intent.** Anding phrases the question as whether FASB standards "satisfy the FASB's intent." Cheng: "Although [the SEC] mandates [X] with the intention to [goal], whether [X] achieves it remains largely unexplored."
- **Cite the call you answer, with a section number.** Cheng: "see Blankespoor et al. (2020), Section 4.1.6." A pinpoint citation turns "understudied" into "requested."
- **One "However, it is unclear" per literature stream.** Anding closes each of three streams with it (P019–P021), then translates the setting into the literature's terms in a bridge paragraph (P022).
- **Put the gap in one sentence.** Tillet's whole gap is a single "yet few studies" clause inside paragraph 1.

## The theory: pick one, apply it to the setting, name what it predicts

Choose the theory that predicts a hidden cost next to the regulator's intended benefit, and apply it to your setting in its own terms. The three papers sit at three points on a spectrum.

| Approach | Paper | How it works | Strength | Risk |
| --- | --- | --- | --- | --- |
| **Argued causal chain** | Anding | No named theory. Resource constraints (staffing, standards complex and ill-fitting to firms' situations, auditor distraction) built step by step from several literatures | Flexible; fits a new phenomenon | Reads as a list of reasons unless the reasons are later reused as moderators |
| **Borrowed formal model** | Cheng | Rational inattention: Lu (2022) on summary vs. detail, Peng & Xiong (2006) on reading in sequence; each model gives numbered takeaways | Predictions map one-to-one onto tests | Needs a setting where the model's premises plausibly hold |
| **Two-sided theory, one side chosen** | Tillet | Institutional isomorphism has an institutional and a strategic version; the paper argues the institutional one dominates here | The counter-argument comes from the same theory | Must justify why this setting favours one side |

**Suggestions**

- **Apply the theory in your setting's own words.** Cheng: "Applying rational inattention theory to the 10-K setting, …" Anding: "[new standards] represent a change to [the process the literature studies]."
- **Name your framework or construct.** Cheng's "two-stage sequential acquisition framework"; Tillet's "superficial comparability." A name lets you refer back to it and lets others cite it.
- **Consider dropping the literature section.** Cheng has none. Positioning sits in the contributions and inside the theory section, so every citation does theoretical work.
- **Summarize the theory in the intro in one paragraph** (Anding P5, Cheng P6, Tillet P006). The reader should know the tension before reaching Section 2.
- **When picking one side of a debate, say so plainly.** Tillet: a recent paper supports the strategic view; "However, I predict" the institutional one wins, because accounting rules are strongly enforced.

## From theory to hypotheses: three ways to build them

Pick one of three ways to get from theory to hypotheses, and keep to it for the whole section. Each gives every prediction a counter-argument and draws the later tests from the main argument.

### Pattern A — For, against, resolve, then moderators (Anding)

Use it when the literature looks mixed and you have no single formal theory.

1. **Arguments for**, one causal step per sentence, closing with a numbered summary: "Collectively, [X] have two primary sources of difficulty: (1) [A] and (2) [B]."
2. **"On the other hand"**: the strongest case for the opposite effect, including a concurrent study.
3. **Resolve the mixed evidence by redefining the outcome**: prior work finds gains in *targeted* quality; the workload literature predicts losses in *overall* quality. "As such, I state my first hypothesis in the alternative form."
4. **H1**, directional, one line, no hedge.
5. **Moderators from the H1 arguments**: "Collectively, the arguments for H1 stem from three primary sources: [A], [B], and [C]." → H2a–c. The cross-sections read as theory tests, not fishing.
6. **Rival mechanisms with different predictions about where the effect shows up** (related vs. unrelated accounts), previewed in the intro.

### Pattern B — Premises, framework, prediction, joint test (Cheng)

Use it with a borrowed formal model.

1. **Premise stated as fact**: "Processing a disclosure involves an active economic choice … trading off [benefit] against [cost]."
2. **The model's takeaways, numbered**: "Two takeaways from [model] are especially relevant: i) …, and ii) …"
3. **Applied to the setting**: benefit then cost in one paragraph ("However, these details come at a cost").
4. **The framework, named**: "we propose a [n]-stage [process] framework."
5. **The prediction, its premises, and what a null means**: "this prediction rests on two premises. First, … Second, … If either condition fails, … Thus, our prediction serves as a joint test of [A] and [B]."
6. **Cross-sections framed as tests of the theory's core assumption.**

### Pattern C — One argument, two hypotheses with opposite signs (Tillet)

Use it when the headline finding is a trade-off.

1. **The regulator's prediction, then the threats to it**: "there are at least two aspects of the standard that may contravene this objective."
2. **Declare the shared argument first**: "My first two hypotheses are predicated on a single argument: [change] will lead to diverging outcomes on [construct] for [group A] versus [group B]."
3. **For each hypothesis: argument → H → "Alternatively"**, with the counter-argument drawn from the same theory (other institutions keep up the pressure) rather than a rival theory.
4. **State in the null when the theory cannot sign it**: "Given these conflicting arguments, I state the following hypothesis in the null form."
5. **Seed your most original test in the hypothesis section** (superficial comparability, P046), so it returns later as a contribution, not a surprise.

### Rules all three follow

- **Every hypothesis gets a counter-argument.** Anding and Tillet give it its own paragraph. Cheng names the rival (users ignore exhibits) next to the prediction.
- **"Alternative form" when the theory picks a side; "null form" when it does not.** Say which, and why.
- **Moderators and mechanisms come from the main argument.** Never introduce a cross-section the theory section did not set up.
- **Translate each hypothesis into a coefficient sign in one sentence**, either at the end of the theory section or in the design: "[H] predicts [direction], which implies a test of whether the coefficient on [interaction] is [sign]." (Tillet)
- **Keep the wording parallel across sub-hypotheses** (Anding H2a–c).

## The introduction, paragraph by paragraph

Aim for 13–17 paragraphs and about 1,700–2,300 words, the range of the three papers. Below is a suggested order that combines their best moves.

| ¶ | Job | Model |
| --- | --- | --- |
| 1 | Regulator's promise + one number + gap in one clause + research question | All three, P003 |
| 2 | Why it matters now: frequency, stakes, or a second motive ("The motivation is twofold") | Anding P004; Cheng P004–005 |
| 3 | Definition of the construct and why this component or setting | Tillet P004 |
| 4 | Institutional arc: old regime → reform → the regulator's objective in its own words | Tillet P005 |
| 5 | Theory in one paragraph: the force, the prediction, the rival | Cheng P009; Tillet P006 |
| 6 | Measurement or data advantage, with its caveat in the same paragraph | Cheng; Anding P3 |
| 7–8 | Main finding: credit the regulator first, then "However" the cost | Tillet P008 |
| 9 | Why the next step is open (bridge to the second question or mechanism) | Tillet P010 |
| 10 | The identification threat named, with its answers | Cheng P012 |
| 11 | Mechanism and cross-sections, organized by the moderators from the theory | Anding 7–10 |
| 12–14 | Contributions: policy first, then each literature, each answering a named call | Cheng P015–016; Tillet P012–015 |
| 15 | The main caveat, stated in the intro | Tillet P016 |

**Suggestions**

- **Credit the regulator before the downside.** "which indicates that the FASB met one of its objectives with ASC 606. However, …" (Tillet). The cost result then reads as balanced, not hostile.
- **Put a caveat in the same paragraph as the claim.** It takes away the referee's first point.
- **Make bounded priority claims.** "first … using a standard, publicly available LLM for identification" (Anding), not "first to study X."
- **Contributions answer someone.** "We respond to the call by Blankespoor et al. (2020)" (Cheng); Tillet answers Blankespoor et al.'s "we know little about" sentence.
- **Skip the roadmap paragraph.** Anding has none, and the intro reads tighter for it.

## Pitfalls to avoid

Each of the three papers has a front-end flaw a referee would notice. Avoid them by design.

| Pitfall | Where it happens | Fix |
| --- | --- | --- |
| A hypothesis argued directionally but stated without a direction | Anding H2a–c; partial results then labelled "support for H2b" | State the direction the argument implies, or argue why it cannot be signed |
| The same argument made three times | Tillet's isomorphism argument in P006, P028, P029 | Make it once in full in Section 2; refer back to it elsewhere |
| A hypothesis buried in a run-in subhead | Tillet H3 sits inside 2.1, so it reads as an afterthought | Give each research question its own subsection |
| A hook that overstates the construct | Cheng says "users"; the measure is EDGAR downloads, conceded in footnote 3 | Use the measured construct's name in the hook, or concede it in the same paragraph |
| Moderators added after the fact | (Avoided by all three) | Draw every cross-section from the H1 arguments |
| Causal language on a design that cannot carry it | Anding's path analysis; Cheng's mediation in the online appendix | Match the verbs in the theory section to what the design can show |

## Checklist before submission

Tick each item against the draft; any unticked item is a likely referee comment.

- [ ] Paragraph 1 quotes or paraphrases a regulator's stated goal.
- [ ] Paragraph 1 has one number that shows scale, and ends with the research question.
- [ ] The gap is stated as an untested promise, and its type (scope, observability, linkage) is clear.
- [ ] At least one call for research is cited with a pinpoint (section or page).
- [ ] One theory or framework is named and applied to the setting in its own terms.
- [ ] The theory is summarized in the intro in one paragraph, including the rival prediction.
- [ ] Every hypothesis has a counter-argument paragraph ("On the other hand" / "Alternatively").
- [ ] Each hypothesis says whether it is in the alternative or the null form, and why.
- [ ] Every moderator and mechanism test traces back to an argument made for H1.
- [ ] Your most original test is seeded in the theory section, not introduced in the results.
- [ ] Each hypothesis is translated into a coefficient sign in one sentence.
- [ ] The intro credits the regulator before reporting the cost.
- [ ] The main caveat is in the intro, next to the claim it qualifies.
- [ ] No argument appears in full more than once.
`
}

/**
 * Write-if-absent the intro-check skill and its guide, so projects created
 * before this feature pick it up on their next open. New projects get the same
 * templates from `scaffold.ts`. Hooked into `ensureQuartoDocs`.
 */
export async function ensureIntroCheck(projectPath: string): Promise<void> {
  await fs.mkdir(resolve(projectPath, SKILL_DIR), { recursive: true })
  await writeIfAbsent(join(projectPath, SKILL_REL), introCheckSkill())
  await writeIfAbsent(join(projectPath, GUIDE_REL), introCheckGuide())
}

async function writeIfAbsent(path: string, content: string): Promise<void> {
  try {
    await fs.access(path)
    return // already present — never clobber a hand-edited skill
  } catch {
    /* absent — write it */
  }
  await fs.writeFile(path, content, 'utf8')
}
