export const taskBriefsMigration = {
  name: 'task-briefs',
  sql: `
    ALTER TABLE tasks ADD COLUMN brief TEXT
      CHECK (
        brief IS NULL OR (
          length(trim(brief, char(9) || char(10) || char(13) || ' ')) BETWEEN 1 AND 16384
          AND instr(brief, char(0)) = 0
        )
      );
  `,
  version: 12,
} as const;
