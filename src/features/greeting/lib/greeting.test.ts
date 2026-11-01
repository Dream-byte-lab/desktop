import { describe, expect, it } from "vitest";
import { greetingAt } from "./greeting";

function at(hour: number): Date {
  return new Date(2026, 10, 1, hour, 0, 0);
}

describe("greetingAt", () => {
  it("greets by name in the morning", () => {
    expect(greetingAt(at(8), "Achieng").headline).toBe("Good morning, Achieng");
    expect(greetingAt(at(5), "Achieng").headline).toBe("Good morning, Achieng");
    expect(greetingAt(at(11), "Achieng").headline).toBe(
      "Good morning, Achieng",
    );
  });

  it("wishes a happy lunch at midday", () => {
    expect(greetingAt(at(12)).headline).toBe("Happy lunch");
    expect(greetingAt(at(13)).headline).toBe("Happy lunch");
  });

  it("moves through afternoon and evening", () => {
    expect(greetingAt(at(14)).headline).toBe("Good afternoon");
    expect(greetingAt(at(16)).headline).toBe("Good afternoon");
    expect(greetingAt(at(17)).headline).toBe("Good evening");
    expect(greetingAt(at(21)).headline).toBe("Good evening");
  });

  it("acknowledges the late hours, before and after midnight", () => {
    expect(greetingAt(at(22)).headline).toBe("Up late");
    expect(greetingAt(at(23)).headline).toBe("Up late");
    expect(greetingAt(at(0)).headline).toBe("Up late");
    expect(greetingAt(at(4)).headline).toBe("Up late");
  });

  it("works without a name and always carries a subline", () => {
    const greeting = greetingAt(at(19));
    expect(greeting.headline).toBe("Good evening");
    expect(greeting.subline.length).toBeGreaterThan(0);
  });
});
