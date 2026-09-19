/**
 * Two example documents, so the page can be tried without having one to hand.
 *
 * They are written to show what the tool is for rather than to be impressive: the
 * diary has dates, a place, a person, an amount and a picture, so every part of the
 * answer panel has something to show; the resume has dated roles, so the timeline has
 * something to draw. Both are short on purpose — indexing either one takes a second.
 */

export interface Sample {
  id: string;
  title: string;
  blurb: string;
  text: string;
}

const DIARY = `4 March 2026
Cold again. The boiler made the noise it makes before it gives up, and by the evening there was no heat at all. I called the building and they said someone would come. Nobody came.

6 March 2026
The technician arrived at half past nine and was gone by ten — the circuit board, he said, and he had one in the van. £0, because it is the building's problem, not mine. The flat was warm by lunchtime. I walked down to the waterfront in the afternoon and watched the ice breaking up.

11 March 2026
Rang my mother. She is still in Grimsby and still refusing to move. We argued about it for twenty minutes and then talked about the garden for an hour, which is how it always goes.

18 March 2026
Rain all day. Wrote nothing. Read the whole of the report Andrea sent and made notes in the margin, which is the only way I can read anything anymore.

22 March 2026
Andrea came over with the paperwork for the cottage. $1,450 for the week in July, which is more than I wanted to spend, but she has already paid the deposit and I am not going to be the one who argues about it again.

26 March 2026
Frost on the window this morning and then a proper spring afternoon, the first one. Sat outside the cafe on James Street with a coffee until it got cold. The cherry trees along the street have started.

![the cherry trees on James Street](https://images.example.org/james-street-april.jpg)

2 April 2026
Worst week in a long time. The boiler again on the Tuesday, the car on the Thursday, and the letter from the bank on the Friday. I did not sleep properly once.

9 April 2026
Better. Fixed the fence. Andrea brought the dog over and we walked the rail trail as far as the old mill and back, which is about nine kilometres and my legs knew it.

17 April 2026
Started the new contract. It is only six weeks but it is work and it pays on time, which after the last year is not nothing.`;

const RESUME = `SUMMARY
Senior software engineer with fifteen years building web platforms in TypeScript and Node.js. Most recently leading a small team on a payments platform, and before that a long stretch in health records.

EXPERIENCE

Senior Software Engineer, First Canadian Title
July 2021 to September 2026, Hamilton, Ontario
Led the migration of the title-search platform from a legacy PHP monolith to a TypeScript and PostgreSQL service, cutting median response time from 1.8 seconds to 240 milliseconds. Built the GraphQL layer the mobile team still uses. Mentored four engineers, two of whom were promoted.

Software Engineer, Utherverse Digital
March 2018 to June 2021, Remote
Worked on the virtual-world client and its API. Wrote the asset pipeline that cut build times by 70 per cent and the caching layer that removed most of the peak-load incidents.

Developer, IOU Concepts
January 2017 to February 2018, Windsor, Ontario
Built internal tools for the operations team in Node.js and React. First role where I owned a production system end to end.

EDUCATION
Honours Bachelor of Computer Science, University of Windsor, 2010 to 2014.

SKILLS
TypeScript, JavaScript, Node.js, React, Next.js, GraphQL, PostgreSQL, MongoDB, Docker, AWS.

PROJECTS
A small transformer language model written from scratch in TypeScript, trained in the browser. A search tool that indexes a long document locally and answers questions from it with citations.`;

export const SAMPLES: Sample[] = [
  {
    id: 'diary',
    title: 'A diary',
    blurb:
      'Nine dated entries across two months, with a place, a person, an amount and a picture. Ask when the heating failed, what the weather was like, or which month was worse.',
    text: DIARY,
  },
  {
    id: 'resume',
    title: 'A resume',
    blurb:
      'Three dated roles and a summary. Ask where someone worked in 2019, how long they were at a company, or what they did with PostgreSQL.',
    text: RESUME,
  },
];
