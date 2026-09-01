import { describe, expect, it } from "vitest";
import { I18N, isInitialSampleInput } from "../i18n";
import { parseDBML } from "../parser/dbml";

describe("isInitialSampleInput", () => {
  it("recognizes both built-in DBML samples despite surrounding whitespace", () => {
    expect(isInitialSampleInput(I18N.zh.sample)).toBe(true);
    expect(isInitialSampleInput(` \n${I18N.en.sample}\n `)).toBe(true);
  });

  it("does not treat edited or user-provided DBML as the initial sample", () => {
    expect(isInitialSampleInput(`${I18N.zh.sample}\nTable Extra { id int [pk] }`)).toBe(false);
    expect(isInitialSampleInput("Table User { ID INT [pk] }")).toBe(false);
    expect(isInitialSampleInput("")).toBe(false);
  });

  it.each([I18N.zh.sample, I18N.en.sample])(
    "keeps every built-in DBML sample warning-free",
    (sample) => {
      const result = parseDBML(sample);
      expect(result.tables).toHaveLength(3);
      expect(result.relationships).toHaveLength(2);
      expect(result.warnings).toBeUndefined();
    },
  );
});
