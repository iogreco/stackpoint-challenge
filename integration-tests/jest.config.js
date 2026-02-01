module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 120000, // 2 minutes for E2E tests
  moduleNameMapper: {
    '^@stackpoint/shared$': '<rootDir>/../packages/shared/src',
  },
};
