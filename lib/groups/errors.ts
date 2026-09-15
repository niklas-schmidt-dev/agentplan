export class GroupNotFoundError extends Error {
  constructor() {
    super("Group not found.");
    this.name = "GroupNotFoundError";
  }
}

export class InvalidGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGroupError";
  }
}
