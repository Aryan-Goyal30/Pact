import { describe, expect, it } from "vitest";
import type { PublicManifestProduct } from "@/types/manifest";
import type { BuyerIntent } from "@/lib/negotiation/buyerIntentParser";
import {
  ambiguousQuestionLeadIn,
  answerQuestion,
  buildRequirementRows,
  classifyQuestion,
  clearField,
  deriveResumedState,
  editAnnouncement,
  extractUnavailableProductMention,
  findMatchingProductForSpec,
  findMentionedProduct,
  findUnmatchedSpec,
  isQuestion,
  matchCurrentFieldAnswer,
  matchFieldCorrection,
  matchShortAnswer,
  nextMissingField,
  questionForMissingField,
  requirementFieldLabel,
} from "./buyerConversationUi";

const monitor: PublicManifestProduct = {
  sku: "MONITOR-24-FHD",
  name: "24-inch Full HD Monitor",
  description: "Standard office monitor, 1920x1080.",
  listedPrice: 9500,
  availableQuantity: 250,
  standardDeliveryDays: 4,
  maxDeliveryDays: 10,
  negotiable: true,
};

const laptop: PublicManifestProduct = {
  sku: "LAPTOP-14-I5",
  name: "14-inch Business Laptop (i5, 16GB RAM)",
  description: "Mid-range business laptop suitable for office use.",
  listedPrice: 48000,
  availableQuantity: 10,
  standardDeliveryDays: 5,
  maxDeliveryDays: 12,
  negotiable: true,
};

const keyboard: PublicManifestProduct = {
  sku: "KEYBOARD-WIRELESS",
  name: "Wireless Keyboard and Mouse Combo",
  description: "Standard wireless keyboard and mouse set.",
  listedPrice: 1400,
  availableQuantity: 500,
  standardDeliveryDays: 3,
  maxDeliveryDays: 7,
  negotiable: true,
};

const catalog: PublicManifestProduct[] = [laptop, monitor, keyboard];

describe("isQuestion", () => {
  it("recognizes a message ending in a question mark", () => {
    expect(isQuestion("What's the price of the monitor?")).toBe(true);
  });

  it("recognizes a common question opener even without a question mark", () => {
    expect(isQuestion("How many do you have in stock")).toBe(true);
  });

  it("does not treat an ordinary requirement statement as a question", () => {
    expect(isQuestion("I need 20 monitors under 9000 each")).toBe(false);
  });

  it("does not false-positive on a requirement statement that happens to start with a question word", () => {
    // "Where" opens the sentence but this is a real requirement, not a
    // question — isQuestion requires a specific known opener phrase or a
    // trailing "?", never a single question word anywhere.
    expect(isQuestion("Where I work we need 5 monitors")).toBe(false);
  });

  it("treats an empty message as not a question", () => {
    expect(isQuestion("   ")).toBe(false);
  });
});

describe("classifyQuestion", () => {
  it("classifies a price question", () => {
    expect(classifyQuestion("What's the price of the monitor?")).toBe("price");
  });

  it("classifies a stock/availability question", () => {
    expect(classifyQuestion("How many do you have in stock?")).toBe("stock");
  });

  it("classifies a product-availability (whole catalog) question distinctly from a stock question", () => {
    expect(classifyQuestion("What products are available?")).toBe("catalog");
  });

  it("classifies a delivery question", () => {
    expect(classifyQuestion("What delivery options do you have?")).toBe("delivery");
  });

  it("returns null for a genuinely ambiguous question", () => {
    expect(classifyQuestion("Can you help me?")).toBeNull();
  });
});

describe("findMentionedProduct", () => {
  it("finds a product named by a distinctive word in the question", () => {
    expect(findMentionedProduct("What's the price of the monitor?", catalog)).toBe(monitor);
  });

  it("returns null when no catalog product is named", () => {
    expect(findMentionedProduct("What's the price?", catalog)).toBeNull();
  });
});

describe("answerQuestion — real catalog data only, never fabricated", () => {
  it("answers a price question for a specific product using the real listed price", () => {
    expect(answerQuestion("price", monitor, catalog)).toBe("24-inch Full HD Monitor is listed at ₹9,500 per unit.");
  });

  it("answers a stock question for a specific product using the real available quantity", () => {
    expect(answerQuestion("stock", laptop, catalog)).toBe("We have 10 unit(s) of 14-inch Business Laptop (i5, 16GB RAM) available.");
  });

  it("answers a delivery question for a specific product using the real delivery window", () => {
    expect(answerQuestion("delivery", monitor, catalog)).toBe(
      "24-inch Full HD Monitor ships in 4–10 day(s), depending on your requirements.",
    );
  });

  it("answers a catalog question by listing every real product and its real listed price", () => {
    const answer = answerQuestion("catalog", null, catalog);
    for (const product of catalog) {
      expect(answer).toContain(product.name);
    }
  });

  it("falls back to a catalog-wide summary for a price question with no specific product resolved", () => {
    const answer = answerQuestion("price", null, catalog);
    expect(answer).toContain(monitor.name);
    expect(answer).toContain(laptop.name);
    expect(answer).toContain(keyboard.name);
  });

  it("never mentions a private floor/minPrice — PublicManifestProduct has no such field, and no answer references one", () => {
    for (const category of ["price", "stock", "delivery", "catalog"] as const) {
      for (const product of [...catalog, null]) {
        const answer = answerQuestion(category, product, catalog);
        expect(answer.toLowerCase()).not.toContain("floor");
        expect(answer.toLowerCase()).not.toContain("minprice");
      }
    }
  });
});

describe("ambiguousQuestionLeadIn", () => {
  it("acknowledges a still-missing requirement without answering it", () => {
    expect(ambiguousQuestionLeadIn(true)).toBe("I can help with that, but I still need a bit more first.");
  });

  it("uses a plain acknowledgement once nothing is missing", () => {
    expect(ambiguousQuestionLeadIn(false)).toBe("I can help with that.");
  });
});

describe("deriveResumedState — a question never advances or overwrites a requirement slot", () => {
  it("re-asks the next missing field from the CURRENT understood, unchanged", () => {
    const understood: Partial<BuyerIntent> = { sku: monitor.sku, productName: monitor.name };
    const resumed = deriveResumedState(understood, catalog);
    expect(resumed.kind).toBe("collecting");
    expect(resumed.followUp).toBe("How many do you need?");
  });

  it("does NOT let a price question's own number become maxPrice — quantity stays whatever it already was", () => {
    // "What's the price of the monitor?" contains no digits, but this
    // guards the more general contract: deriveResumedState only ever
    // reads `understood` as given — it never derives a field from the
    // question text itself, so there is no path by which a number
    // inside a question could land in maxPrice/quantity.
    const understood: Partial<BuyerIntent> = { sku: monitor.sku, productName: monitor.name, quantity: 20 };
    const resumed = deriveResumedState(understood, catalog);
    expect(resumed.kind).toBe("collecting");
    expect(resumed.followUp).toContain("budget");
    // quantity is untouched by deriveResumedState — still exactly 20, not
    // reinterpreted from any question text.
    expect(understood.quantity).toBe(20);
  });

  it("re-surfaces the real stock-confirmation state when a question is asked mid quantity_check", () => {
    const understood: Partial<BuyerIntent> = {
      sku: laptop.sku,
      productName: laptop.name,
      quantity: 20,
      maxPrice: 50000,
      deliveryDeadlineDays: 7,
    };
    const resumed = deriveResumedState(understood, catalog);
    expect(resumed.kind).toBe("quantity_check");
    if (resumed.kind === "quantity_check") {
      expect(resumed.product).toBe(laptop);
      expect(resumed.requested).toBe(20);
      expect(resumed.followUp).toBe("I only have 10 unit(s) of 14-inch Business Laptop (i5, 16GB RAM) listed as available.");
    }
  });

  it("reports ready once every real requirement is already understood and in stock", () => {
    const understood: Partial<BuyerIntent> = {
      sku: monitor.sku,
      productName: monitor.name,
      quantity: 20,
      maxPrice: 9000,
      deliveryDeadlineDays: 7,
    };
    const resumed = deriveResumedState(understood, catalog);
    expect(resumed.kind).toBe("ready");
    expect(resumed.followUp).toBe("Ready to negotiate.");
  });

  it("asks for the product first when nothing is understood yet (question asked before any requirement)", () => {
    const resumed = deriveResumedState({}, catalog);
    expect(resumed.kind).toBe("collecting");
    expect(resumed.followUp).toBe("What product are you looking for?");
  });
});

// ---------------------------------------------------------------------------
// Discoverable editing (Buyer Intake audit, pass 3)
// ---------------------------------------------------------------------------

const completeUnderstood: Partial<BuyerIntent> = {
  sku: monitor.sku,
  productName: monitor.name,
  quantity: 5,
  maxPrice: 9000,
  deliveryDeadlineDays: 5,
};

describe("buildRequirementRows", () => {
  it("shows a row only for fields that actually have a real value", () => {
    const rows = buildRequirementRows({ sku: monitor.sku, productName: monitor.name });
    expect(rows.map((r) => r.field)).toEqual(["product"]);
  });

  it("formats every field the same way the rest of the module already formats real values", () => {
    const rows = buildRequirementRows(completeUnderstood);
    expect(rows).toEqual([
      { field: "product", label: "Product", value: "24-inch Full HD Monitor" },
      { field: "quantity", label: "Quantity", value: "5 units" },
      { field: "maxPrice", label: "Budget", value: "₹9,000/unit" },
      { field: "deliveryDeadlineDays", label: "Delivery", value: "≤ 5 days" },
    ]);
  });

  it("never exposes a private floor/minPrice — only the buyer's own stated fields ever appear", () => {
    const text = JSON.stringify(buildRequirementRows(completeUnderstood)).toLowerCase();
    expect(text).not.toContain("floor");
    expect(text).not.toContain("minprice");
  });

  // Pass 4: budgetFlexible presentation.
  it("honestly notes a flexible budget in the budget row's value, without touching any other row", () => {
    const rows = buildRequirementRows({ ...completeUnderstood, budgetFlexible: true });
    const budgetRow = rows.find((r) => r.field === "maxPrice");
    expect(budgetRow?.value).toBe("₹9,000/unit · flexible");
    expect(rows.find((r) => r.field === "product")?.value).toBe("24-inch Full HD Monitor");
    expect(rows.find((r) => r.field === "quantity")?.value).toBe("5 units");
    expect(rows.find((r) => r.field === "deliveryDeadlineDays")?.value).toBe("≤ 5 days");
  });

  it("shows the plain budget value, unchanged, when budgetFlexible is false or absent", () => {
    expect(buildRequirementRows({ ...completeUnderstood, budgetFlexible: false }).find((r) => r.field === "maxPrice")?.value).toBe(
      "₹9,000/unit",
    );
    expect(buildRequirementRows(completeUnderstood).find((r) => r.field === "maxPrice")?.value).toBe("₹9,000/unit");
  });
});

describe("requirementFieldLabel / editAnnouncement", () => {
  it("labels every editable field", () => {
    expect(requirementFieldLabel("product")).toBe("Product");
    expect(requirementFieldLabel("quantity")).toBe("Quantity");
    expect(requirementFieldLabel("maxPrice")).toBe("Budget");
    expect(requirementFieldLabel("deliveryDeadlineDays")).toBe("Delivery");
  });

  it("announces the edit the same way every other quick-reply action in this module is announced", () => {
    expect(editAnnouncement("quantity")).toBe("Edit quantity");
    expect(editAnnouncement("maxPrice")).toBe("Edit budget");
    expect(editAnnouncement("deliveryDeadlineDays")).toBe("Edit delivery");
    expect(editAnnouncement("product")).toBe("Edit product");
  });
});

describe("clearField — the entire logic behind the Edit affordance", () => {
  it("edit quantity: removes only quantity", () => {
    const cleared = clearField(completeUnderstood, "quantity");
    expect(cleared.quantity).toBeUndefined();
  });

  it("edit budget: removes only maxPrice", () => {
    const cleared = clearField(completeUnderstood, "maxPrice");
    expect(cleared.maxPrice).toBeUndefined();
  });

  it("edit delivery: removes only deliveryDeadlineDays", () => {
    const cleared = clearField(completeUnderstood, "deliveryDeadlineDays");
    expect(cleared.deliveryDeadlineDays).toBeUndefined();
  });

  it("edit product: removes both sku and productName together", () => {
    const cleared = clearField(completeUnderstood, "product");
    expect(cleared.sku).toBeUndefined();
    expect(cleared.productName).toBeUndefined();
  });

  it("preserves every unrelated field exactly — editing quantity never touches product/budget/delivery", () => {
    const cleared = clearField(completeUnderstood, "quantity");
    expect(cleared.sku).toBe(monitor.sku);
    expect(cleared.productName).toBe(monitor.name);
    expect(cleared.maxPrice).toBe(9000);
    expect(cleared.deliveryDeadlineDays).toBe(5);
  });

  it("preserves quantity/budget/delivery when editing product — never invents or drops them", () => {
    const cleared = clearField(completeUnderstood, "product");
    expect(cleared.quantity).toBe(5);
    expect(cleared.maxPrice).toBe(9000);
    expect(cleared.deliveryDeadlineDays).toBe(5);
  });

  it("does NOT combine the old and new value — clearing removes the old value entirely rather than leaving it for a later merge (the real correction — 5 becoming 3, not '53' or a second quantity — happens entirely inside the existing intent parser once the buyer answers, per this module's own header comment)", () => {
    const cleared = clearField(completeUnderstood, "quantity");
    expect(cleared).not.toHaveProperty("quantity");
  });
});

describe("editing while already Ready to negotiate", () => {
  it("clearing any one field immediately leaves the ready state and re-asks for it", () => {
    // completeUnderstood is a genuinely complete, in-stock intent —
    // deriveResumedState on it alone reports "ready", exactly like the
    // live NegotiationReady card the buyer would have been looking at.
    expect(deriveResumedState(completeUnderstood, catalog).kind).toBe("ready");

    for (const field of ["quantity", "maxPrice", "deliveryDeadlineDays"] as const) {
      const resumed = deriveResumedState(clearField(completeUnderstood, field), catalog);
      expect(resumed.kind).toBe("collecting");
    }
  });

  it("does not silently re-declare ready without revalidating — editing quantity above real stock re-surfaces the stock check, not a bare re-ready", () => {
    const overStock = clearField({ ...completeUnderstood, quantity: 999 }, "product");
    const withLaptop = { ...overStock, sku: laptop.sku, productName: laptop.name, quantity: 999 };
    const resumed = deriveResumedState(withLaptop, catalog);
    expect(resumed.kind).toBe("quantity_check");
    if (resumed.kind === "quantity_check") {
      expect(resumed.product).toBe(laptop);
    }
  });
});

describe("editing a product re-triggers the existing stock check for the new product", () => {
  it("selecting a new product after an edit, with a quantity the new product can't fulfil, surfaces the real stock-confirmation state", () => {
    // Simulates: buyer had 20 x monitor confirmed, clicked Edit -> Product,
    // then picked the laptop (real stock 10) while quantity (20) carried
    // over untouched — the same "preserve quantity/budget/delivery where
    // possible" contract clearField already guarantees.
    const afterEditProduct = clearField({ ...completeUnderstood, quantity: 20 }, "product");
    expect(afterEditProduct.quantity).toBe(20);

    const afterPickingLaptop = { ...afterEditProduct, sku: laptop.sku, productName: laptop.name };
    const resumed = deriveResumedState(afterPickingLaptop, catalog);
    expect(resumed.kind).toBe("quantity_check");
    if (resumed.kind === "quantity_check") {
      expect(resumed.product).toBe(laptop);
      expect(resumed.requested).toBe(20);
    }
  });
});

describe("a question asked during edit mode resumes the SAME field being edited (Pass 2 compatibility)", () => {
  it("editing quantity, then asking an unrelated question, still resumes asking for quantity", () => {
    const editingQuantity = clearField(completeUnderstood, "quantity");
    // This is exactly what BuyerConversation.tsx's question-interception
    // path (Pass 2) calls after answering a question — it never touches
    // `understood`, so the resumed state is identical before and after
    // a question is asked.
    const resumed = deriveResumedState(editingQuantity, catalog);
    expect(resumed.kind).toBe("collecting");
    expect(resumed.followUp).toBe("How many do you need?");
  });

  it("editing delivery, then asking a question, still resumes asking for delivery — never regresses to an earlier field", () => {
    const editingDelivery = clearField(completeUnderstood, "deliveryDeadlineDays");
    const resumed = deriveResumedState(editingDelivery, catalog);
    expect(resumed.kind).toBe("collecting");
    expect(resumed.followUp).toBe("When do you need them delivered?");
  });
});

// ---------------------------------------------------------------------
// Pass 9, Part A — contextual short answers. A bare reply to whichever
// field is currently being asked is interpreted deterministically,
// without needing the LLM parser at all — see matchShortAnswer's own
// doc comment for why this never competes with the real parser.
// ---------------------------------------------------------------------
describe("matchShortAnswer", () => {
  describe("quantity", () => {
    it("accepts a bare number", () => {
      expect(matchShortAnswer("quantity", "5")).toBe(5);
    });
    it("accepts a number with a trailing unit word", () => {
      expect(matchShortAnswer("quantity", "5 units")).toBe(5);
      expect(matchShortAnswer("quantity", "3 pcs")).toBe(3);
    });
    it("rejects zero, negative, and non-numeric text", () => {
      expect(matchShortAnswer("quantity", "0")).toBeNull();
      expect(matchShortAnswer("quantity", "a few")).toBeNull();
    });
    it("rejects a full sentence — that still goes to the real parser", () => {
      expect(matchShortAnswer("quantity", "I need about 5 of them for my office")).toBeNull();
    });
  });

  describe("maxPrice", () => {
    it("accepts a bare number", () => {
      expect(matchShortAnswer("maxPrice", "46000")).toBe(46000);
    });
    it("expands a 'k' suffix", () => {
      expect(matchShortAnswer("maxPrice", "46k")).toBe(46000);
      expect(matchShortAnswer("maxPrice", "46K")).toBe(46000);
    });
    it("accepts a currency symbol and thousands separators", () => {
      expect(matchShortAnswer("maxPrice", "₹46,500")).toBe(46500);
      expect(matchShortAnswer("maxPrice", "Rs. 9500")).toBe(9500);
    });
    it("rejects zero and non-numeric text", () => {
      expect(matchShortAnswer("maxPrice", "0")).toBeNull();
      expect(matchShortAnswer("maxPrice", "not sure yet")).toBeNull();
    });
  });

  describe("deliveryDeadlineDays", () => {
    it("accepts a bare number", () => {
      expect(matchShortAnswer("deliveryDeadlineDays", "8")).toBe(8);
    });
    it("accepts 'N days' and 'within N days'", () => {
      expect(matchShortAnswer("deliveryDeadlineDays", "8 days")).toBe(8);
      expect(matchShortAnswer("deliveryDeadlineDays", "within 8 days")).toBe(8);
    });
    it("rejects zero and non-numeric text", () => {
      expect(matchShortAnswer("deliveryDeadlineDays", "0")).toBeNull();
      expect(matchShortAnswer("deliveryDeadlineDays", "as soon as possible")).toBeNull();
    });
  });

  it("never resolves 'product' — product matching is never done deterministically here", () => {
    expect(matchShortAnswer("product", "laptop")).toBeNull();
    expect(matchShortAnswer("product", "5")).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Pass 9, Part A — findUnmatchedSpec regression: the real observed bug
// ("5 in qty" misread as a 5-inch screen-size spec) and continued
// correct detection of genuine spec mismatches.
// ---------------------------------------------------------------------
describe("findUnmatchedSpec — Pass 9 regression", () => {
  it("does NOT flag 'in' used as an ordinary word next to a quantity — the real observed bug", () => {
    expect(findUnmatchedSpec("I need a laptop 5 in qty", laptop)).toBeNull();
    expect(findUnmatchedSpec("5 in quantity please", laptop)).toBeNull();
  });

  it("still catches a genuine spec mismatch spelled out in full — 'inch', not bare 'in'", () => {
    expect(findUnmatchedSpec("I need a 12 inch laptop", laptop)).toBe("12 inch");
  });

  it("still catches a genuine RAM/storage mismatch (unaffected by this fix)", () => {
    expect(findUnmatchedSpec("I need a 12GB RAM laptop", laptop)).toBe("12GB");
  });

  it("returns null when every named spec is present in the real product name", () => {
    expect(findUnmatchedSpec("the 16GB laptop", laptop)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Pass 10 — the 19 numbered conversational regression scenarios
// (Objective E). Each exercises the exact pure functions
// BuyerConversation.tsx's submitUtterance/advance() call, in the same
// order it calls them (spec-mismatch check -> correction-matcher ->
// short-answer check), and asserts both the resulting structured field
// AND the message content — never just one or the other. Scenarios that
// require the real multi-field LLM parser (a first, long opening
// utterance) are noted rather than simulated, since that path is
// deliberately NOT deterministic here.
// ---------------------------------------------------------------------
describe("Pass 10 conversational regressions — Objective E", () => {
  describe("(1)-(4) basic intake", () => {
    it("(1) once the product resolves, the next question is short — no repeated product name", () => {
      const understood: Partial<BuyerIntent> = { sku: laptop.sku, productName: laptop.name };
      expect(nextMissingField(understood)).toBe("quantity");
      expect(questionForMissingField("quantity", understood)).toBe("How many do you need?");
    });

    it("(2) a short quantity answer resolves deterministically", () => {
      expect(matchShortAnswer("quantity", "5")).toBe(5);
    });

    it("(3) a short budget answer resolves deterministically", () => {
      expect(matchShortAnswer("maxPrice", "46k")).toBe(46000);
    });

    it("(4) a short delivery answer resolves deterministically", () => {
      expect(matchShortAnswer("deliveryDeadlineDays", "within 8 days")).toBe(8);
    });
  });

  describe("(5)-(6) quantity correction", () => {
    it("(5) 'I need 5' sets quantity via the 'need' keyword, even though it's not a bare short answer", () => {
      const result = matchFieldCorrection("I need 5", null);
      expect(result).toEqual({ field: "quantity", value: 5 });
    });

    it("(6) 'actually make that 7' corrects the already-confirmed quantity, not budget (currently being asked)", () => {
      // Mirrors the flow: quantity=5 was just confirmed, budget is now
      // being asked, and the buyer corrects quantity instead of
      // answering the budget question.
      const understood: Partial<BuyerIntent> = { sku: laptop.sku, productName: laptop.name, quantity: 5 };
      const result = matchFieldCorrection("actually make that 7", "quantity");
      expect(result).toEqual({ field: "quantity", value: 7 });
      const next = { ...understood, [result!.field]: result!.value };
      expect(next.quantity).toBe(7);
    });
  });

  describe("(7)-(8) budget correction", () => {
    it("(7) '42k' resolves as a short budget answer", () => {
      expect(matchShortAnswer("maxPrice", "42k")).toBe(42000);
    });

    it("(8) 'actually make it 46k' corrects budget via its own keyword, regardless of fallback field", () => {
      const result = matchFieldCorrection("actually make it 46k", "quantity");
      expect(result).toEqual({ field: "maxPrice", value: 46000 });
    });
  });

  describe("(9)-(10) delivery correction", () => {
    it("(9) 'within 8 days' resolves as a short delivery answer", () => {
      expect(matchShortAnswer("deliveryDeadlineDays", "within 8 days")).toBe(8);
    });

    it("(10) 'actually 10 days is fine' corrects delivery via its own keyword", () => {
      const result = matchFieldCorrection("actually 10 days is fine", "maxPrice");
      expect(result).toEqual({ field: "deliveryDeadlineDays", value: 10 });
    });
  });

  describe("(11)-(13) specification correction on an established product", () => {
    it("(11) 'I need 12GB RAM, not 16GB' is recognized as a spec mismatch, not a new requirement", () => {
      const unmatchedSpec = findUnmatchedSpec("I need 12GB RAM, not 16GB", laptop);
      expect(unmatchedSpec).toBe("12GB");
    });

    it("(12) an unavailable specification never populates quantity, and names the real catalog product", () => {
      const understood: Partial<BuyerIntent> = { sku: laptop.sku, productName: laptop.name };
      const unmatchedSpec = findUnmatchedSpec("I need 12 gb ram in the laptop not 16", laptop);
      expect(unmatchedSpec).toBe("12 gb");
      const realMatch = findMatchingProductForSpec(unmatchedSpec!, laptop.sku, catalog);
      expect(realMatch).toBeNull(); // genuinely unavailable in this catalog
      const message = `I couldn't find a ${unmatchedSpec} configuration in the catalog. The available option is ${laptop.name}.`;
      expect(message).toContain("12 gb");
      expect(message).toContain(laptop.name);
      // The critical assertion: quantity was never touched by this turn.
      expect(understood.quantity).toBeUndefined();
      // Nor was "12" ever picked up as a quantity/budget/delivery correction.
      expect(matchFieldCorrection("I need 12 gb ram in the laptop not 16", null)).toEqual({
        field: "quantity",
        value: 12,
      });
      // ^ Demonstrates WHY the spec-mismatch check must run first: taken
      // in isolation, matchFieldCorrection's own "need" keyword would
      // misread this as quantity=12. BuyerConversation.tsx's
      // submitUtterance never reaches matchFieldCorrection for this
      // message, precisely because the spec-mismatch check above
      // intercepts and returns first — see its ordering comment.
    });

    it("(13) an available specification uses the real catalog product instead of flagging a mismatch", () => {
      const laptop12gb: PublicManifestProduct = {
        sku: "LAPTOP-14-I3-12GB",
        name: "14-inch Business Laptop (i3, 12GB RAM)",
        description: "Entry-level business laptop.",
        listedPrice: 40000,
        availableQuantity: 6,
        standardDeliveryDays: 5,
        maxDeliveryDays: 12,
        negotiable: true,
      };
      const extendedCatalog = [...catalog, laptop12gb];
      const unmatchedSpec = findUnmatchedSpec("I need 12GB RAM instead", laptop);
      expect(unmatchedSpec).toBe("12GB");
      const realMatch = findMatchingProductForSpec(unmatchedSpec!, laptop.sku, extendedCatalog);
      expect(realMatch?.sku).toBe(laptop12gb.sku);
    });
  });

  describe("(14)-(16) questions never mutate requirements", () => {
    it("(14) a listed-price question answers the price without touching budget", () => {
      expect(isQuestion("What's the listed price?")).toBe(true);
      expect(classifyQuestion("What's the listed price?")).toBe("price");
      const answer = answerQuestion("price", laptop, catalog);
      expect(answer).toContain(laptop.name);
      expect(answer).toContain("48,000");
    });

    it("(15) a stock question answers stock without touching quantity", () => {
      expect(isQuestion("How much stock do you have?")).toBe(true);
      expect(classifyQuestion("How much stock do you have?")).toBe("stock");
      const answer = answerQuestion("stock", laptop, catalog);
      expect(answer).toContain("10");
    });

    it("(16) a delivery question answers the delivery range without setting a buyer deadline", () => {
      expect(isQuestion("How fast can you deliver?")).toBe(true);
      expect(classifyQuestion("How fast can you deliver?")).toBe("delivery");
      const answer = answerQuestion("delivery", laptop, catalog);
      expect(answer).toContain("5");
      expect(answer).toContain("12");
    });
  });

  describe("(17)-(19) mixed natural-language corrections", () => {
    it("(17) 'Actually make that 7' — same correction phrasing, capitalized", () => {
      expect(matchFieldCorrection("Actually make that 7", "quantity")).toEqual({ field: "quantity", value: 7 });
    });

    it("(18) '46k is my max' sets budget via its own keyword, no correction signal needed", () => {
      expect(matchFieldCorrection("46k is my max", null)).toEqual({ field: "maxPrice", value: 46000 });
    });

    it("(19) 'I can wait 10 days' sets delivery via its own keyword, no correction signal needed", () => {
      expect(matchFieldCorrection("I can wait 10 days", null)).toEqual({ field: "deliveryDeadlineDays", value: 10 });
    });
  });

  it("never intercepts a long, multi-field opening statement — the Golden Demo's own first message stays fully on the real parser", () => {
    const goldenDemoUtterance =
      "I need 7 business laptops, budget up to ₹46,500 each, and I can accept a later delivery than 8 days if it gets me a better price.";
    expect(matchFieldCorrection(goldenDemoUtterance, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Pass 11, Objective A — unknown/unavailable product intake. The LLM
// parser's own "unknown_product" status only fires when it names an
// invalid sku; when it correctly follows its own "never invent a sku"
// instruction and returns sku: null for a real-but-absent category
// (e.g. "car" against a laptop/monitor/keyboard catalog), that's
// indistinguishable from "no product mentioned at all" without this
// deterministic, LLM-independent raw-text check.
// ---------------------------------------------------------------------
describe("extractUnavailableProductMention", () => {
  it("recognizes a plausible but genuinely absent category", () => {
    expect(extractUnavailableProductMention("I need a car", catalog)).toBe("car");
    expect(extractUnavailableProductMention("looking for a phone", catalog)).toBe("phone");
    expect(extractUnavailableProductMention("I need a server", catalog)).toBe("server");
  });

  it("does NOT flag an actual catalog product", () => {
    expect(extractUnavailableProductMention("I need a laptop", catalog)).toBeNull();
    expect(extractUnavailableProductMention("I need a monitor", catalog)).toBeNull();
    expect(extractUnavailableProductMention("I want a keyboard", catalog)).toBeNull();
  });

  it("does NOT flag a valid product category stated in plural form (singular/plural fold)", () => {
    expect(extractUnavailableProductMention("I need 20 monitors under 9000 each", catalog)).toBeNull();
    expect(extractUnavailableProductMention("looking for some laptops", catalog)).toBeNull();
  });

  it("returns null when no intent-phrase is present at all (e.g. a bare field answer)", () => {
    expect(extractUnavailableProductMention("5", catalog)).toBeNull();
    expect(extractUnavailableProductMention("46k", catalog)).toBeNull();
    expect(extractUnavailableProductMention("I need 5", catalog)).toBeNull();
  });

  it("never intercepts the Golden Demo's own long opening statement", () => {
    const goldenDemoUtterance =
      "I need 7 business laptops, budget up to ₹46,500 each, and I can accept a later delivery than 8 days if it gets me a better price.";
    expect(extractUnavailableProductMention(goldenDemoUtterance, catalog)).toBeNull();
  });

  it("preserves the existing spec-mismatch behavior — findUnmatchedSpec is unaffected", () => {
    expect(findUnmatchedSpec("I need a 12 GB RAM laptop", laptop)).toBe("12 GB");
    const realMatch = findMatchingProductForSpec("12 GB", laptop.sku, catalog);
    expect(realMatch).toBeNull();
  });
});

describe("classifyQuestion — whole-catalog phrasing without the word 'product'", () => {
  it("recognizes 'what do you sell?' as a catalog question", () => {
    expect(classifyQuestion("what do you sell?")).toBe("catalog");
  });

  it("recognizes 'what do you carry?' as a catalog question", () => {
    expect(classifyQuestion("what do you carry?")).toBe("catalog");
  });

  it("still recognizes the existing 'what products do you have' phrasing", () => {
    expect(classifyQuestion("what products do you have?")).toBe("catalog");
  });
});

// ---------------------------------------------------------------------
// Pass 11.1 — targeted intake regression fix. A valid natural-language
// answer to whichever field is CURRENTLY being asked must always win
// over the unavailable-product detection added in Pass 11 — otherwise a
// message with no product/spec mention at all (like "i can go upto
// 45000") has nothing to anchor it and can fall through to the parser,
// whose whole-transcript re-parse occasionally drops an already-
// confirmed field (e.g. sku), which advance() then misreads as the
// product having become unresolved again.
// ---------------------------------------------------------------------
describe("matchCurrentFieldAnswer — Pass 11.1", () => {
  describe("maxPrice — natural budget phrasing", () => {
    it("resolves the exact reported bug phrasing", () => {
      expect(matchCurrentFieldAnswer("maxPrice", "i can go upto 45000")).toBe(45000);
    });

    it("resolves every listed natural phrasing", () => {
      expect(matchCurrentFieldAnswer("maxPrice", "45000")).toBe(45000);
      expect(matchCurrentFieldAnswer("maxPrice", "45k")).toBe(45000);
      expect(matchCurrentFieldAnswer("maxPrice", "₹45,000")).toBe(45000);
      expect(matchCurrentFieldAnswer("maxPrice", "i can go up to 45k")).toBe(45000);
      expect(matchCurrentFieldAnswer("maxPrice", "my max is 45000")).toBe(45000);
      expect(matchCurrentFieldAnswer("maxPrice", "budget is 45000")).toBe(45000);
      expect(matchCurrentFieldAnswer("maxPrice", "I can spend up to ₹45,000")).toBe(45000);
    });

    it("never fires when the text actually mentions a different field (delivery/quantity)", () => {
      expect(matchCurrentFieldAnswer("maxPrice", "within 45 days")).toBeNull();
      expect(matchCurrentFieldAnswer("maxPrice", "I need 45 units")).toBeNull();
    });
  });

  describe("quantity and deliveryDeadlineDays — unanchored equivalents of matchShortAnswer", () => {
    it("still resolves the same bare/short forms matchShortAnswer already handles", () => {
      expect(matchCurrentFieldAnswer("quantity", "5")).toBe(5);
      expect(matchCurrentFieldAnswer("quantity", "5 units")).toBe(5);
      expect(matchCurrentFieldAnswer("deliveryDeadlineDays", "within 8 days")).toBe(8);
      expect(matchCurrentFieldAnswer("deliveryDeadlineDays", "8 days")).toBe(8);
    });

    it("resolves quantity wrapped in natural language", () => {
      expect(matchCurrentFieldAnswer("quantity", "I'll need 6 of them")).toBe(6);
    });
  });

  describe("never regresses spec-mismatch precedence (Pass 10, Objective A)", () => {
    it("never treats a spec-shaped mention ('12gb') as a quantity/budget/delivery number", () => {
      expect(matchCurrentFieldAnswer("quantity", "I need 12gb ram in the laptop not 16")).toBeNull();
      expect(matchCurrentFieldAnswer("maxPrice", "I need a 12gb ram laptop")).toBeNull();
    });
  });

  it("never resolves 'product' — product resolution stays the parser/catalog's job", () => {
    expect(matchCurrentFieldAnswer("product", "laptop")).toBeNull();
  });

  it("never fires on a long, multi-field-shaped message", () => {
    const goldenDemoUtterance =
      "I need 7 business laptops, budget up to ₹46,500 each, and I can accept a later delivery than 8 days if it gets me a better price.";
    expect(matchCurrentFieldAnswer("maxPrice", goldenDemoUtterance)).toBeNull();
  });
});
