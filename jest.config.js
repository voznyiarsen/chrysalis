/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  moduleFileExtensions: ["tsx", "ts", "js", "json", "node"],
  testMatch: ["**/tests/**/*.test.ts"],
  testPathIgnorePatterns: ["<rootDir>/codeArchive/"],
  rootDir: ".",
  moduleNameMapper: {
    "^(\\.{1,2}/.+)\\.js$": "$1",
    "^(\\.{1,2}/.+)\\.tsx$": "$1",
  },
  transformIgnorePatterns: ["/node_modules/(?!(ink|ink-.*|react-.*)/)"],
  forceExit: true,
  detectOpenHandles: false,
};
