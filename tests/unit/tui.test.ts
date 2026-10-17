import { getBotNumberFromTag } from "../../src/tui";

describe("getBotNumberFromTag", () => {
  test("extracts the bot number from tagged log lines", () => {
    expect(getBotNumberFromTag("[bot1] Client")).toBe(1);
    expect(getBotNumberFromTag("[bot12] Command")).toBe(12);
    expect(getBotNumberFromTag("[bot2]")).toBe(2);
  });

  test("returns null for logs without a bot tag", () => {
    expect(getBotNumberFromTag("")).toBeNull();
    expect(getBotNumberFromTag("Client")).toBeNull();
    expect(getBotNumberFromTag("[botx] Client")).toBeNull();
    expect(getBotNumberFromTag("[bot] Client")).toBeNull();
  });

  test("only matches the leading tag", () => {
    expect(getBotNumberFromTag("prefix [bot2] Client")).toBeNull();
  });
});
