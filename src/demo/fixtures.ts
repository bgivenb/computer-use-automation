export type DemoMember = {
  id: string;
  name: string;
  savingsBalance: string;
};

const members = {
  "12345": {
    id: "12345",
    name: "Avery Morgan",
    savingsBalance: "$12,450.67",
  },
  "77777": {
    id: "77777",
    name: "Jordan Lee",
    savingsBalance: "$7,777.77",
  },
  "88888": {
    id: "88888",
    name: "Casey Rivera",
    savingsBalance: "$8,888.88",
  },
  "99999": {
    id: "99999",
    name: "Morgan Reyes",
    savingsBalance: "$9,999.99",
  },
} as const satisfies Record<string, DemoMember>;

export function findDemoMember(id: string): DemoMember | undefined {
  return members[id as keyof typeof members];
}
