export interface IFaceE {
  tag(): string;
}

export class BaseE implements IFaceE {
  tag(): string {
    return 'E';
  }
}
