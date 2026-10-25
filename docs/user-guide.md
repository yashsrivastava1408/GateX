# How to get your file checked

A short guide for anyone who wants an Excel, CSV or PDF file checked against a scorecard. It takes about ten minutes to learn. The result
comes back in a few minutes, or up to half an hour for a very big file.

**What a scorecard is.** A scorecard is a list of questions the file should get right, such as "Does every item have a clear definition?".
Each question has a weight, which says how much it matters. GateX marks every question from 0 to 5 and turns the marks into one score out of 100.

## 1. Add your file and your scorecard

1. Open GateX. The home page shows how a check works; click **Check a file** (or open the dashboard from the footer and click **New check**).
2. Add **your file** (the work you want checked) and **your scorecard**. They must be two different files. The scorecard can be in almost any
   layout: Excel, CSV, PDF or text. GateX reads it for you.
3. Give the work a **project name**, and use the same name every time you check the same work. GateX keeps every round under that name, so you
   can watch your score climb.
4. Click **Start the check**. For a repeat run, tick **Quick check**: every question is marked once and the second look at each issue is skipped, which is about a third faster.
   For a steadier score, tick **Check twice for a steadier score**: GateX does the whole check two times and shows the average of the two scores. It takes about
   twice as long. The report shows both scores and how far apart they are. If they are 8 or more points apart, or fall in different colours, a note says
   "Result is unstable, treat it as a range", so read the score as a range and not a single number.

Want to guide the Examiners? Type a few words in the **extra instructions** box, for example "Treat the Notes column as out of scope". The same
words go to all three Examiners and are saved with the report.

## 2. What happens during a check

- **Counting.** GateX counts everything that can be counted, such as blank cells and repeated ids. Code does this, so the numbers are exact.
- **Marking.** Three AI Examiners, called Examiner 1, Examiner 2 and Examiner 3, mark the rest on their own. They cannot see each other's
  marks, and each mark points at a real cell in your file.
- **Comparing.** A Final reviewer compares the three sets of marks. If the Examiners agree, the mark stands. If they differ, the middle mark
  stands (the lower one when two are left) unless the Final reviewer shows, with a cell in your file, that it should move. A very low mark that
  quotes nothing from the file is not counted. Questions the Examiners differ on, and the most important questions, are marked again first.
- **Deciding.** A fixed rule turns the score into a colour. No AI picks the colour.

You can watch each step as it runs.

**One check runs at a time.** If someone else's check is running, yours is saved and shows **Waiting (n in line)**, with your place. It starts by itself when the ones ahead of it finish, so you do not have to stay on the page. Your files are kept. You can still open reports, download them and add more files while you wait. To change your mind, open the waiting check and choose **Cancel this check**. A check that has already started cannot be stopped.

## 3. Read the report

- **The colour comes from the score alone.** Below 60 is **red**, 60 to 74 is **amber**, and 75 or more is **green**. The same rule is used
  everywhere in GateX and in every report.
- **The score** is out of 100 and uses the weights in your scorecard.
- **Close to the line.** When the score is within 4 points of 60 or 75, another check could land on the other side. The report then says
  "Close to the line", shows the range the score could fall in, and GateX has already looked a second time at the questions the Examiners
  disagreed on. The colour still comes from the score alone; treat a close result as a range, not one exact number.
- **Needs attention** lines sit at the top. They point out things worth a look first, such as a must-pass question that scored low or a mark
  that only one Examiner backed. They do not change the colour.
- **What to improve** is your to-do list. Start at the top. Each issue is marked **Must fix**, **Should fix** or **Nice to fix**, and says
  where it is (a sheet and cell), what is wrong and how to fix it.
- **The path to green** shows the smallest set of fixes that lifts the score to the next colour, and how many points each one adds.
- **Charts** in the PDF show the score, how each question did and how the Examiners compared.

**Worth a look is a second, quieter list.** The main list holds issues GateX can stand behind: found by an exact check of the file, or raised by two or more Examiners, or
proved by the cells they name. Suggestions that only one Examiner made, and that the computer check could not prove, are kept apart under **Worth a look** (closed by default in the dashboard, on its own sheet in Excel, in its own
section in the PDF). Some are useful, but more of them are wrong or too vague, so they are not counted in the numbers, the must-fix note or the path to green. They never change the score or the colour.

**What the check used.** The report ends with a line such as "This check used 1,730,000 tokens in and 89,000 out", with a cost when a price list is set up (`server/config/prices.json`).

**Issues marked "code" are the most dependable.** They come from an exact check of every row: a blank cell in a column that is otherwise full,
a repeated id, a reference to something that does not exist, a child count that does not match the rows, a definition made of filler. Each one
points at exactly the cells that need the fix.

**Issues from the Examiners are good leads.** When two or three Examiners raised the same thing, it is usually worth fixing. When only one did,
take a quick look at the cell it points to. The report also lists the issues GateX set aside, with the reason for each. GateX takes a second look at every issue the examiners raise: if the file itself shows an issue is wrong, GateX sets it aside and shows the cell and the exact words that prove it.

## 4. Fix and check again

Fix the issues, then add the file again under the **same project name**. The project page shows every round and how the score moved, which
issues were fixed, which are still open and which are new. Keep going until the colour is green.

## Help prove GateX is right

GateX is only as useful as it is accurate, and only a person can say whether it is. Two small things help, and neither changes your result:

- **Compare with a person.** At the bottom of a finished check, give your own 0 to 5 mark for each area, without looking at GateX's, then save. The two are shown side by side with the gap.
- **Mark an issue.** Open an issue and choose **Right**, **Wrong** or **Unclear**. Add your name once; it is remembered in your browser.

The **Accuracy** page adds these up against the targets from the Roadmap. Until enough people have marked enough different files, it says "Not enough data yet" instead of passing or failing. Numbers marked **AI stand-in** were made by an AI and are not a human check.

## Good to know

- The score is a quick, consistent review that guides your work. You decide which issues to fix.
- GateX is sharpest on **register-style sheets**, where each row is one item with an id and a definition: every row gets an exact check. For a
  free-form document, you get the Examiners' issues.
- A **PDF** is read as text, with its tables rebuilt row by row.
- A question that needs evidence from outside the file, such as an interview, is marked from what the file says about it. If the file says
  nothing, the question is left out of the score and listed under "Not in the file".
- A scorecard is converted once and then reused, so every round of a project is marked against the same scorecard.

## Helpful messages

- *"Another check is running. Yours is next and starts by itself when it finishes."*: nothing is wrong. Yours is waiting its turn.

- *"The file to check and the scorecard are the same file"*: the same file went into both boxes. Add two different files.
- *"The scorecard names a sheet that this workbook does not have"*: compare the sheet names in your file with the scorecard.
- If one Examiner is shown as unavailable, the check finishes with the others, and the report says so next to the colour.

For how the checks work inside, see [the engine page](agent.md). For working on the code, see [development](development.md).
