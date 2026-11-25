/**
 * A starter test catalogue, loaded only when the lab asks for it ("Add common tests").
 *
 * Adult reference ranges are common values from routine Indian lab reports. Children's ranges
 * (blood count, glucose, creatinine, potassium, alkaline phosphatase, TSH, ESR) are approximate
 * values from standard paediatric references (Harriet Lane, CALIPER). They vary with method and
 * population: every lab must check all of them against its own analysers and kits, with its
 * pathologist, before issuing reports. A child with no children's range is shown the adult range,
 * marked "(adult range)" on the report.
 * Prices are left at ₹0: a test can't be billed until the lab sets its price.
 */
import type { ParameterInput, RangeSex, TestInput } from "@ojas/shared";

type Range = { sex: RangeSex; low: number | null; high: number | null; ageFrom: number | null; ageTo: number | null; criticalLow?: number | null; criticalHigh?: number | null };
/** An adult (or all-ages) range. */
const r = (low: number | null, high: number | null, sex: RangeSex = "ANY"): Range => ({ sex, low, high, ageFrom: null, ageTo: null });
/** Ages in years, written as days, months or years. */
const D = (n: number) => n / 365.25, M = (n: number) => n / 12, Y = (n: number) => n;
/** A children's range for ages [from, to). */
const kid = (from: number, to: number | null, low: number | null, high: number | null, sex: RangeSex = "ANY", crit: { low?: number; high?: number } = {}): Range =>
  ({ sex, low, high, ageFrom: from, ageTo: to, criticalLow: crit.low ?? null, criticalHigh: crit.high ?? null });

// Shared children's bands for the blood count.
const HB_KIDS = [
  kid(0, D(7), 14.5, 22.5, "ANY", { low: 10, high: 25 }), kid(D(7), M(1), 12.5, 20.5, "ANY", { low: 9, high: 24 }),
  kid(M(1), M(2), 10, 18), kid(M(2), M(3), 9, 14), kid(M(3), M(6), 9.5, 13.5), kid(M(6), Y(2), 10.5, 13.5),
  kid(Y(2), Y(6), 11.5, 13.5), kid(Y(6), Y(12), 11.5, 15.5), kid(Y(12), Y(18), 13, 16, "M"), kid(Y(12), Y(18), 12, 16, "F"),
];
const PCV_KIDS = [
  kid(0, D(7), 45, 67), kid(D(7), M(1), 39, 63), kid(M(1), M(2), 31, 55), kid(M(2), M(3), 28, 42), kid(M(3), M(6), 29, 41),
  kid(M(6), Y(2), 33, 39), kid(Y(2), Y(6), 34, 40), kid(Y(6), Y(12), 35, 45), kid(Y(12), Y(18), 37, 49, "M"), kid(Y(12), Y(18), 36, 46, "F"),
];
const MCV_KIDS = [
  kid(0, D(7), 95, 121), kid(D(7), M(1), 88, 126), kid(M(1), M(6), 74, 108), kid(M(6), Y(2), 70, 86),
  kid(Y(2), Y(6), 75, 87), kid(Y(6), Y(12), 77, 95), kid(Y(12), Y(18), 78, 98),
];
const TLC_KIDS = [
  kid(0, D(7), 9000, 30000, "ANY", { high: 40000 }), kid(D(7), M(1), 5000, 21000), kid(M(1), M(6), 5000, 19500),
  kid(M(6), Y(2), 6000, 17500), kid(Y(2), Y(6), 5000, 15500), kid(Y(6), Y(12), 4500, 13500), kid(Y(12), Y(18), 4500, 11000),
];
const PLT_KIDS = [kid(0, Y(18), 150, 450)];
const GLU_KIDS = [kid(0, M(1), 45, 100, "ANY", { low: 40 }), kid(M(1), Y(18), 60, 100)];
const CREAT_KIDS = [
  kid(0, M(1), 0.3, 1.0), kid(M(1), Y(1), 0.15, 0.4), kid(Y(1), Y(4), 0.2, 0.4), kid(Y(4), Y(7), 0.2, 0.5),
  kid(Y(7), Y(13), 0.3, 0.7), kid(Y(13), Y(18), 0.5, 1.0),
];
const K_KIDS = [kid(0, M(1), 3.7, 5.9), kid(M(1), Y(1), 4.1, 5.3), kid(Y(1), Y(18), 3.4, 4.7)];
const ALP_KIDS = [
  kid(0, D(15), 90, 273), kid(D(15), Y(1), 134, 518), kid(Y(1), Y(10), 156, 369), kid(Y(10), Y(13), 141, 460),
  kid(Y(13), Y(15), 127, 517, "M"), kid(Y(13), Y(15), 62, 280, "F"), kid(Y(15), Y(18), 89, 365, "M"), kid(Y(15), Y(18), 54, 128, "F"),
];
const TSH_KIDS = [kid(0, D(7), 1.0, 39), kid(D(7), M(5), 1.7, 9.1), kid(M(5), Y(18), 0.7, 6.4)];

const num = (id: string, name: string, unit: string, decimals: number, ranges: Range[], extra: Partial<ParameterInput> = {}): ParameterInput =>
  ({ id, name, unit, kind: "NUMERIC", decimals, ranges, ...extra });
const choice = (id: string, name: string, choices: string[], normal: string, extra: Partial<ParameterInput> = {}): ParameterInput =>
  ({ id, name, kind: "CHOICE", choices, normal, ...extra });
const txt = (id: string, name: string, extra: Partial<ParameterInput> = {}): ParameterInput => ({ id, name, kind: "TEXT", ...extra });

const NEG = ["Negative", "Positive"];
const GRADE = ["Nil", "Trace", "1+", "2+", "3+", "4+"];
const TITRE = ["Below 1:20", "1:20", "1:40", "1:80", "1:160", "1:320", "1:640"];
const WIDAL_NOTE = "A titre of 1:160 or more is usually significant; a single titre should be read with the clinical picture.";

export const STARTER_TESTS: TestInput[] = [
  {
    code: "CBC", name: "Complete blood count", section: "HAEM", sampleType: "EDTA", price: 0, tatHours: 4, method: "Automated cell counter",
    aliases: ["CBC", "Complete blood count", "Hemogram", "Haemogram", "Blood routine", "CBP"],
    parameters: [
      num("hb", "Haemoglobin", "g/dL", 1, [r(13, 17, "M"), r(12, 15, "F"), ...HB_KIDS], { criticalLow: 7, criticalHigh: 20 }),
      num("rbc", "RBC count", "million/µL", 2, [r(4.5, 5.5, "M"), r(3.8, 4.8, "F")]),
      num("pcv", "PCV (haematocrit)", "%", 1, [r(40, 50, "M"), r(36, 46, "F"), ...PCV_KIDS]),
      num("mcv", "MCV", "fL", 1, [r(83, 101), ...MCV_KIDS]),
      num("mch", "MCH", "pg", 1, [r(27, 32)]),
      num("mchc", "MCHC", "g/dL", 1, [r(31.5, 34.5)]),
      num("tlc", "Total leucocyte count", "cells/µL", 0, [r(4000, 11000), ...TLC_KIDS], { criticalLow: 2000, criticalHigh: 30000 }),
      num("neut", "Neutrophils", "%", 0, [r(40, 80)], { group: "Differential count" }),
      num("lymph", "Lymphocytes", "%", 0, [r(20, 40)], { group: "Differential count" }),
      num("mono", "Monocytes", "%", 0, [r(2, 10)], { group: "Differential count" }),
      num("eos", "Eosinophils", "%", 0, [r(1, 6)], { group: "Differential count" }),
      num("baso", "Basophils", "%", 0, [r(0, 2)], { group: "Differential count" }),
      num("plt", "Platelet count", "×10³/µL", 0, [r(150, 410), ...PLT_KIDS], { criticalLow: 50, criticalHigh: 1000 }),
    ],
  },
  {
    code: "ESR", name: "ESR", section: "HAEM", sampleType: "EDTA", price: 0, tatHours: 2, method: "Westergren",
    aliases: ["ESR", "Erythrocyte sedimentation rate"],
    parameters: [num("esr", "ESR (1st hour)", "mm/hr", 0, [r(0, 15, "M"), r(0, 20, "F"), kid(0, Y(18), 0, 10)])],
  },
  {
    code: "BGRP", name: "Blood group & Rh", section: "HAEM", sampleType: "EDTA", price: 0, tatHours: 2, method: "Slide agglutination",
    aliases: ["Blood group", "Blood grouping", "ABO Rh", "Blood group and Rh"],
    parameters: [choice("abo", "ABO group", ["A", "B", "AB", "O"], ""), choice("rh", "Rh (D)", ["Positive", "Negative"], "")],
  },
  {
    code: "FBS", name: "Fasting blood sugar", section: "BIOCHEM", sampleType: "FLUORIDE", price: 0, tatHours: 2, method: "GOD-POD",
    aliases: ["FBS", "Fasting blood sugar", "Fasting sugar", "Blood sugar fasting", "Glucose fasting"],
    parameters: [num("glu", "Glucose, fasting", "mg/dL", 0, [r(70, 100), ...GLU_KIDS], { criticalLow: 50, criticalHigh: 400 })],
  },
  {
    code: "PPBS", name: "Post-prandial blood sugar", section: "BIOCHEM", sampleType: "FLUORIDE", price: 0, tatHours: 2, method: "GOD-POD",
    aliases: ["PPBS", "Post-prandial blood sugar", "PP sugar", "Blood sugar PP", "Post prandial"],
    parameters: [num("glu", "Glucose, 2 h after food", "mg/dL", 0, [r(70, 140)], { criticalLow: 50, criticalHigh: 400 })],
  },
  {
    code: "RBS", name: "Random blood sugar", section: "BIOCHEM", sampleType: "FLUORIDE", price: 0, tatHours: 1, method: "GOD-POD",
    aliases: ["RBS", "Random blood sugar", "Random sugar", "Blood sugar random", "GRBS"],
    parameters: [num("glu", "Glucose, random", "mg/dL", 0, [r(70, 140), kid(0, M(1), 45, 140, "ANY", { low: 40 })], { criticalLow: 50, criticalHigh: 400 })],
  },
  {
    code: "HBA1C", name: "HbA1c", section: "BIOCHEM", sampleType: "EDTA", price: 0, tatHours: 6, method: "HPLC / immunoturbidimetry",
    aliases: ["HbA1c", "Glycated haemoglobin", "Glycosylated hemoglobin", "A1c"],
    parameters: [num("a1c", "HbA1c", "%", 1, [r(null, 5.6)], { refText: "Below 5.7: normal · 5.7–6.4: prediabetes · 6.5 or more: diabetes" })],
  },
  {
    code: "LIPID", name: "Lipid profile", section: "BIOCHEM", sampleType: "SERUM", price: 0, tatHours: 6, method: "Enzymatic",
    aliases: ["Lipid profile", "Lipids", "Cholesterol"], notes: "Best done after a 10–12 hour fast.",
    parameters: [
      num("tc", "Total cholesterol", "mg/dL", 0, [r(null, 200)]),
      num("tg", "Triglycerides", "mg/dL", 0, [r(null, 150)]),
      num("hdl", "HDL cholesterol", "mg/dL", 0, [r(40, null, "M"), r(50, null, "F")]),
      num("ldl", "LDL cholesterol", "mg/dL", 0, [r(null, 100)], { refText: "Below 100: optimal · 100–129: near optimal · 130–159: borderline · 160 or more: high" }),
      num("vldl", "VLDL cholesterol", "mg/dL", 0, [r(2, 30)]),
      num("ratio", "Total cholesterol / HDL", "", 1, [r(null, 5)]),
    ],
  },
  {
    code: "LFT", name: "Liver function test", section: "BIOCHEM", sampleType: "SERUM", price: 0, tatHours: 6,
    aliases: ["LFT", "Liver function test", "Liver profile"],
    parameters: [
      num("tbil", "Bilirubin, total", "mg/dL", 2, [r(0.3, 1.2)]),
      num("dbil", "Bilirubin, direct", "mg/dL", 2, [r(null, 0.3)]),
      num("ast", "AST (SGOT)", "U/L", 0, [r(null, 40)]),
      num("alt", "ALT (SGPT)", "U/L", 0, [r(null, 41)]),
      num("alp", "Alkaline phosphatase", "U/L", 0, [r(40, 129), ...ALP_KIDS]),
      num("tp", "Total protein", "g/dL", 1, [r(6.4, 8.3)]),
      num("alb", "Albumin", "g/dL", 1, [r(3.5, 5.2)]),
      num("glob", "Globulin", "g/dL", 1, [r(2.0, 3.5)]),
    ],
  },
  {
    code: "RFT", name: "Kidney function test", section: "BIOCHEM", sampleType: "SERUM", price: 0, tatHours: 6,
    aliases: ["RFT", "KFT", "Renal function test", "Kidney function test", "Renal profile"],
    parameters: [
      num("urea", "Urea", "mg/dL", 0, [r(15, 45)]),
      num("creat", "Creatinine", "mg/dL", 2, [r(0.7, 1.3, "M"), r(0.6, 1.1, "F"), ...CREAT_KIDS], { criticalHigh: 10 }),
      num("ua", "Uric acid", "mg/dL", 1, [r(3.5, 7.2, "M"), r(2.6, 6.0, "F")]),
      num("na", "Sodium", "mmol/L", 0, [r(135, 145)], { criticalLow: 120, criticalHigh: 160 }),
      num("k", "Potassium", "mmol/L", 1, [r(3.5, 5.1), ...K_KIDS], { criticalLow: 2.5, criticalHigh: 6.5 }),
      num("cl", "Chloride", "mmol/L", 0, [r(98, 107)]),
    ],
  },
  {
    code: "CREAT", name: "Serum creatinine", section: "BIOCHEM", sampleType: "SERUM", price: 0, tatHours: 4,
    aliases: ["Creatinine", "Serum creatinine", "S. creatinine"],
    parameters: [num("creat", "Creatinine", "mg/dL", 2, [r(0.7, 1.3, "M"), r(0.6, 1.1, "F"), ...CREAT_KIDS], { criticalHigh: 10 })],
  },
  {
    code: "TFT", name: "Thyroid profile (T3, T4, TSH)", section: "HORMONE", sampleType: "SERUM", price: 0, tatHours: 24, method: "CLIA",
    aliases: ["Thyroid profile", "TFT", "T3 T4 TSH", "Thyroid function test"],
    parameters: [
      num("t3", "Total T3", "ng/dL", 0, [r(80, 200)]),
      num("t4", "Total T4", "µg/dL", 1, [r(5.1, 14.1)]),
      num("tsh", "TSH", "µIU/mL", 2, [r(0.27, 4.2), ...TSH_KIDS]),
    ],
  },
  {
    code: "TSH", name: "TSH", section: "HORMONE", sampleType: "SERUM", price: 0, tatHours: 24, method: "CLIA",
    aliases: ["TSH", "Thyroid stimulating hormone"],
    parameters: [num("tsh", "TSH", "µIU/mL", 2, [r(0.27, 4.2), ...TSH_KIDS])],
  },
  {
    code: "CRP", name: "C-reactive protein", section: "SERO", sampleType: "SERUM", price: 0, tatHours: 4, method: "Immunoturbidimetry",
    aliases: ["CRP", "C reactive protein"],
    parameters: [num("crp", "CRP", "mg/L", 1, [r(null, 5)])],
  },
  {
    code: "DENGUE", name: "Dengue NS1 / IgM / IgG", section: "SERO", sampleType: "SERUM", price: 0, tatHours: 4, method: "Rapid card",
    aliases: ["Dengue", "Dengue NS1", "Dengue NS1 / IgM", "NS1", "Dengue serology"],
    parameters: [choice("ns1", "NS1 antigen", NEG, "Negative"), choice("igm", "IgM antibody", NEG, "Negative"), choice("igg", "IgG antibody", NEG, "Negative")],
  },
  {
    code: "MP", name: "Malaria antigen", section: "SERO", sampleType: "EDTA", price: 0, tatHours: 2, method: "Rapid card",
    aliases: ["Malaria antigen", "Malaria", "MP", "Malarial parasite", "Malaria card"],
    parameters: [choice("pf", "P. falciparum", NEG, "Negative"), choice("pv", "P. vivax", NEG, "Negative")],
  },
  {
    code: "WIDAL", name: "Widal test", section: "SERO", sampleType: "SERUM", price: 0, tatHours: 4, method: "Slide agglutination",
    aliases: ["Widal", "Widal test", "Typhoid"], notes: WIDAL_NOTE,
    parameters: [
      choice("to", "S. Typhi O", TITRE, ""), choice("th", "S. Typhi H", TITRE, ""),
      choice("ah", "S. Paratyphi AH", TITRE, ""), choice("bh", "S. Paratyphi BH", TITRE, ""),
    ],
  },
  {
    code: "URINE", name: "Urine routine", section: "CLINPATH", sampleType: "URINE", price: 0, tatHours: 2,
    aliases: ["Urine routine", "Urine R/E", "Urine analysis", "Urine RE", "Urine examination", "CUE"],
    parameters: [
      txt("colour", "Colour", { normal: "Pale yellow", group: "Physical" }),
      choice("appear", "Appearance", ["Clear", "Slightly turbid", "Turbid"], "Clear", { group: "Physical" }),
      num("sg", "Specific gravity", "", 3, [r(1.005, 1.03)], { group: "Physical" }),
      num("ph", "pH", "", 1, [r(4.5, 8)], { group: "Chemical" }),
      choice("prot", "Protein", GRADE, "Nil", { group: "Chemical" }),
      choice("glu", "Glucose", GRADE, "Nil", { group: "Chemical" }),
      choice("ket", "Ketones", NEG, "Negative", { group: "Chemical" }),
      choice("bld", "Blood", ["Negative", "Trace", "Positive"], "Negative", { group: "Chemical" }),
      txt("pus", "Pus cells", { unit: "/hpf", refText: "0–5", group: "Microscopy" }),
      txt("rbc", "Red cells", { unit: "/hpf", refText: "0–2", group: "Microscopy" }),
      txt("epi", "Epithelial cells", { unit: "/hpf", refText: "Few", group: "Microscopy" }),
      txt("casts", "Casts", { normal: "Nil", group: "Microscopy" }),
      txt("cryst", "Crystals", { normal: "Nil", group: "Microscopy" }),
    ],
  },
];
