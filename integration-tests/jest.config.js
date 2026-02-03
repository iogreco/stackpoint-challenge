module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 120000, // 2 minutes for E2E tests
  moduleNameMapper: {
    // Use dist for extractors tests (avoids OpenAI import issues), src for everything else
    '^@stackpoint/shared$': '<rootDir>/../packages/shared/dist',
  },
};
