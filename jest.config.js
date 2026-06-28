/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  moduleFileExtensions: ["ts", "js", "json", "node"],
  testMatch: ["**/tests/**/*.test.ts"],
  testPathIgnorePatterns: ["<rootDir>/codeArchive/"],
  rootDir: ".",
  moduleNameMapper: {
    "^(\\.{1,2}/.+)\\.js$": "$1",
  },
  forceExit: true,
  detectOpenHandles: false,
};
