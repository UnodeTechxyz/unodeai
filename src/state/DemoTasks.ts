export interface DemoTask {
  id: string;
  title: string;
  description: string;
  prompt: string;
  expectedOutcome: string;
}

export const DEMO_TASKS: DemoTask[] = [
  {
    id: 'hello-world-http-server',
    title: 'Hello World HTTP Server',
    description: 'Create a tiny TypeScript HTTP server in about 20 lines.',
    prompt:
      'Create a minimal TypeScript HTTP server that replies with "Hello from UnodeAi". Keep it around 20 lines, add a short comment explaining how to run it, and avoid changing unrelated files.',
    expectedOutcome: 'A small TypeScript server file that can be run locally.',
  },
  {
    id: 'unit-tests-selected-file',
    title: 'Add Unit Tests',
    description: 'Add focused Vitest coverage for the currently selected file.',
    prompt:
      'Add 3 to 5 focused Vitest tests for the currently selected file. Cover the most important happy path and at least one edge case. Keep the change scoped and explain any assumptions.',
    expectedOutcome: 'A concise test file or added cases for the selected module.',
  },
  {
    id: 'review-extension-entry',
    title: 'Review Extension Entry',
    description: 'Review src/extension.ts for bugs, risks, and missing tests.',
    prompt:
      'Review src/extension.ts. Prioritize correctness bugs, security risks, behavioral regressions, and missing tests. Return findings first with file and line references, then a short summary.',
    expectedOutcome: 'A review-style report with actionable findings.',
  },
  {
    id: 'react-component',
    title: 'Create React Component',
    description: 'Build a reusable React component with typed props.',
    prompt:
      'Create a reusable React component for this project. Infer the local style and tooling, add typed props, include an empty/loading state where appropriate, and keep the implementation scoped.',
    expectedOutcome: 'A component that follows the project conventions.',
  },
  {
    id: 'project-readme',
    title: 'Write Project README',
    description: 'Draft or improve a README based on the repository contents.',
    prompt:
      'Inspect the repository and draft a practical README. Include what the project does, how to install dependencies, how to run it, how to test it, and any important configuration notes.',
    expectedOutcome: 'A README draft grounded in the current codebase.',
  },
];
