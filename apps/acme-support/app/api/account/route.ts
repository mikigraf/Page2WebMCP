import { NextRequest } from "next/server";
import { acme, errorResponse, session } from "../_fixture";

export function DELETE(request: NextRequest) { try { return acme.deleteAccount(session(request)); } catch (error) { return errorResponse(error); } }
