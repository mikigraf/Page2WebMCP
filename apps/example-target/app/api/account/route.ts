import { NextRequest } from "next/server";
import { errorResponse, partsConsole, session } from "../_runtime";

export function DELETE(request: NextRequest) {
  try {
    return partsConsole().deleteAccount(session(request));
  } catch (error) {
    return errorResponse(error);
  }
}
